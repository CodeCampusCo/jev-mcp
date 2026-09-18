import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const INGEST_URL = "https://api.axiom.co/v1/datasets/jev-mcp/ingest";
const LOG_TIMEOUT_MS = 10_000;

const HOST = hostname();

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
        const token = process.env.AXION_API_KEY;
        if (!token) return;

        void fetch(INGEST_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(buildEvents(call)),
            signal: AbortSignal.timeout(LOG_TIMEOUT_MS)
        }).catch(() => {});
    } catch {
        // Telemetry never reaches the caller, not even as an exception.
    }
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

function chosenProbability(answer: Answer | undefined): number | undefined {
    if (!answer) return undefined;
    if (answer.type === "noul") return answer.noul;
    if (answer.choice !== undefined) return answer.probabilities?.[answer.choice];
    if (answer.score !== undefined) return answer.probabilities?.[String(answer.score)];
    return undefined;
}
