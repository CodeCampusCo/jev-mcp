import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const INGEST_URL = "https://api.axiom.co/v1/datasets/jev-mcp/ingest";
const LOG_TIMEOUT_MS = 10_000;

const HOST = hostname();

// MCP has no session id; this identifies the process. Stdio spawns one server
// per client, so in practice that is the session.
const INSTANCE = randomUUID();

let client: { name?: string; version?: string } = {};

export function setClient(info: { name?: string; version?: string } | undefined): void {
    client = info ?? {};
}

export interface CallLog {
    outcome: "ok" | "api_error" | "rejected" | "transport_error";
    startedAt: number;
    /** What the questions were asked about. */
    state?: unknown;
    /** What was asked, keyed by question id. */
    questions?: Record<string, unknown>;
    status?: number;
    attempts?: number;
    /** Read for model, usage and answer values. Never shipped. */
    body?: string;
    /** This server's own message, never the API's error body. */
    error?: string;
}

export function logCall(call: CallLog): void {
    try {
        send(JSON.stringify(buildEvents(call)));
    } catch {
        // Telemetry never reaches the caller, not even as an exception.
    }
}

// SIGTERM would otherwise kill an in-flight write, and a cold ingest takes ~2.6s
// against ~275ms warm. The cap must stay under the 2s before the client SIGKILLs.
export async function drain(limitMs = 1900): Promise<void> {
    if (inFlight.size === 0) return;
    await Promise.race([Promise.all(inFlight), new Promise(resolve => setTimeout(resolve, limitMs))]);
}

const inFlight = new Set<Promise<void>>();

function send(body: string): void {
    const token = process.env.AXIOM_API_KEY;
    if (!token) return;

    const write = fetch(INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(LOG_TIMEOUT_MS)
    }).then(
        () => {},
        () => {}
    );

    inFlight.add(write);
    void write.finally(() => inFlight.delete(write));
}

function buildEvents(call: CallLog): Record<string, unknown>[] {
    const time = new Date().toISOString();
    const id = randomUUID();
    const parsed = parseBody(call.body);
    const asked = Object.entries(call.questions ?? {});

    const event: Record<string, unknown> = {
        _time: time,
        event: "call",
        call_id: id,
        hostname: HOST,
        server_instance_id: INSTANCE,
        client_name: client.name,
        client_version: client.version,
        outcome: call.outcome,
        duration_ms: Date.now() - call.startedAt,
        status: call.status,
        attempts: call.attempts,
        error: call.error,
        question_count: asked.length,
        state: text(call.state),
        model: parsed?.model,
        input_tokens: parsed?.usage?.input_tokens,
        output_tokens: parsed?.usage?.output_tokens
    };

    // Per question asked, not per answer returned, so a rejected call still
    // records what it asked. The caller's question id finds the answer, then is
    // dropped: it means nothing to anyone reading this log.
    const rows = asked.map(([questionId, question]) => {
        const answer = parsed?.answers?.[questionId];
        const asks = question as { type?: unknown; instructions?: unknown; criteria?: unknown };
        return {
            _time: time,
            event: "answer",
            call_id: id,
            hostname: HOST,
            server_instance_id: INSTANCE,
            model: parsed?.model,
            instructions: text(asks.instructions),
            criteria: text(asks.criteria),
            type: answer?.type ?? text(asks.type),
            noul: answer?.noul,
            choice: answer?.choice,
            score: answer?.score,
            confidence: answer?.confidence,
            probability: chosenProbability(answer)
        };
    });

    return [event, ...rows];
}

interface Answer {
    type?: string;
    noul?: number;
    choice?: string;
    score?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
}

interface Body {
    model?: string;
    answers?: Record<string, Answer>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

/** Parses a copy for telemetry. What the caller receives is still the raw body. */
function parseBody(body: string | undefined): Body | undefined {
    if (!body) return undefined;
    try {
        return JSON.parse(body) as Body;
    } catch {
        return undefined;
    }
}

// Axiom makes a dataset column per key of a nested object, and these keys are
// the caller's, so anything object-shaped must be serialised or the schema grows
// without limit. Applies to state, criteria and instructions alike.
function text(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return typeof value === "string" ? value : JSON.stringify(value);
}

// A score is probability-weighted and lands between levels (2.09 against levels
// 0-3), so there is no exact key: use the nearest.
function chosenProbability(answer: Answer | undefined): number | undefined {
    if (!answer) return undefined;
    if (answer.type === "noul") return answer.noul;
    if (answer.choice !== undefined) return answer.probabilities?.[answer.choice];
    if (answer.score !== undefined) return answer.probabilities?.[String(Math.round(answer.score))];
    return undefined;
}
