import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const INGEST_URL = "https://api.axiom.co/v1/datasets/jev-mcp/ingest";
const LOG_TIMEOUT_MS = 10_000;

const HOST = hostname();

/**
 * MCP's `initialize` carries no session id, only the client's name and version,
 * so this is the honest substitute: an id for this server process. A stdio
 * server is spawned per client, so one process is one session in practice —
 * but it identifies the process, which is why it is not called a session id.
 */
const INSTANCE = randomUUID();

let client: { name?: string; version?: string } = {};

export function setClient(info: { name?: string; version?: string } | undefined): void {
    client = info ?? {};
}

/**
 * No caller content is logged. The state never reaches this module — only a
 * count of questions — and the response body arrives only to have scalars read
 * off it. Nothing string-valued from a state or an error body is shipped.
 */
export interface CallLog {
    outcome: "ok" | "api_error" | "rejected" | "transport_error";
    startedAt: number;
    questionCount?: number;
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

/**
 * Lets writes already in flight finish before the process goes.
 *
 * The MCP client ends stdin, waits 2s, then SIGTERMs, and Node's default action
 * for SIGTERM is to die on the spot. A cold ingest measures ~2.6s from here
 * against ~275ms warm, nearly all of it TLS, so without this the first write of
 * a server that is closed soon after its call never lands — and it fails
 * silently, which is the worst shape for a log to fail in.
 *
 * Only shutdown waits, never a response. The cap sits just inside the 2s the
 * client allows before it escalates to SIGKILL — a cold write can still be
 * running 3s after SIGTERM, so a tighter cap cuts off the write it exists to
 * protect. This makes loss rare, not impossible.
 */
export async function drain(limitMs = 1900): Promise<void> {
    if (inFlight.size === 0) return;
    await Promise.race([Promise.all(inFlight), new Promise(resolve => setTimeout(resolve, limitMs))]);
}

const inFlight = new Set<Promise<void>>();

function send(body: string): void {
    const token = process.env.AXION_API_KEY;
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
        question_count: call.questionCount,
        model: parsed?.model,
        input_tokens: parsed?.usage?.input_tokens,
        output_tokens: parsed?.usage?.output_tokens
    };

    // One row per answer: probability and confidence as queryable columns, not
    // text inside a blob. Accumulated, that is a calibration curve.
    const rows = Object.entries(parsed?.answers ?? {}).map(([questionId, answer]) => ({
        _time: time,
        event: "answer",
        call_id: id,
        hostname: HOST,
        server_instance_id: INSTANCE,
        model: parsed?.model,
        question_id: questionId,
        type: answer?.type,
        noul: answer?.noul,
        choice: answer?.choice,
        score: answer?.score,
        confidence: answer?.confidence,
        probability: chosenProbability(answer)
    }));

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

/**
 * A score is probability-weighted, so it usually falls between levels and there
 * is no exact key for it: today's real answers were 2.09 and 2.10 against levels
 * 0-3. The nearest level is the closest thing to "the answer it gave". For a
 * score the calibration number is `confidence`, not this.
 */
function chosenProbability(answer: Answer | undefined): number | undefined {
    if (!answer) return undefined;
    if (answer.type === "noul") return answer.noul;
    if (answer.choice !== undefined) return answer.probabilities?.[answer.choice];
    if (answer.score !== undefined) return answer.probabilities?.[String(Math.round(answer.score))];
    return undefined;
}
