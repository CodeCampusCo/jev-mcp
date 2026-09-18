import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `..` because this compiles to dist/. Loading here, not in main(), so it lands
// before the module-scope reads below; loadEnvFile leaves set variables alone.
try {
    process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
    }
    // Absent .env is fine; the environment may already carry the key.
}

const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

// Reimplemented from the official SDKs. Match them; do not simplify.
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRY_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;

// Node's fetch has no deadline of its own. 10s matches the official SDKs.
const REQUEST_TIMEOUT_MS = 10_000;

const RETRYABLE_STATUSES = new Set([408, 429, 529]);

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

export const apiUrl = process.env.TYPESAFE_API_URL || DEFAULT_API_URL;
export const defaultModel = process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL;

export interface JevResponse {
    ok: boolean;
    status: number;
    /** Raw. Never parsed, never re-serialised. */
    body: string;
}

export async function callJev(apiKey: string, payload: unknown): Promise<JevResponse> {
    for (let attempt = 0; ; attempt++) {
        let response: Response;
        let body: string;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload),
                // Aborts the body read too, not just the headers.
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            body = await readCapped(response);
        } catch (error) {
            // Retried: ~31s and an error beats hanging forever.
            if (error instanceof ResponseTooLargeError || attempt >= MAX_RETRIES) throw error;
            await sleep(backoffMs(attempt));
            continue;
        }

        if (!response.ok && isRetryable(response.status) && attempt < MAX_RETRIES) {
            await sleep(retryAfterMs(response.headers) ?? backoffMs(attempt));
            continue;
        }

        return { ok: response.ok, status: response.status, body };
    }
}

function isRetryable(status: number): boolean {
    return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function backoffMs(attempt: number): number {
    const delay = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
    return delay * (1 - Math.random() * RETRY_JITTER);
}

// Not in the published API reference; these exist only in the official SDK
// source. Looks like dead code. Is not.
function retryAfterMs(headers: Headers): number | undefined {
    const milliseconds = headers.get("retry-after-ms");
    if (milliseconds !== null) {
        const parsed = Number.parseFloat(milliseconds);
        if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, MAX_RETRY_AFTER_MS);
    }

    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
        const seconds = Number.parseFloat(retryAfter);
        const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, MAX_RETRY_AFTER_MS);
    }

    return undefined;
}

async function readCapped(response: Response): Promise<string> {
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ResponseTooLargeError(`Jev response exceeded ${MAX_RESPONSE_BYTES} bytes and was abandoned.`);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
