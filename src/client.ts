/**
 * The HTTP side: one POST to the Jev endpoint, with the retry behaviour of the
 * official TypeSafe SDKs reimplemented rather than simplified.
 */

const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

// Matches the official SDKs: 2 retries, 500ms doubling to a 5s ceiling, and up
// to 25% of each delay shaved off as jitter.
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRY_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;

const RETRYABLE_STATUSES = new Set([408, 429, 529]);

/** Guard against an oversized body exhausting memory. A typed answer is tiny. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const apiUrl = process.env.TYPESAFE_API_URL || DEFAULT_API_URL;
export const defaultModel = process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL;

export interface JevResponse {
    ok: boolean;
    status: number;
    /** The raw response body, passed back to the caller unchanged. */
    body: string;
}

export async function callJev(apiKey: string, payload: unknown): Promise<JevResponse> {
    for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });
        } catch (error) {
            // A connection-level failure never reached the API, so it is retried
            // like a 5xx — the official SDKs do the same.
            if (attempt < MAX_RETRIES) {
                await sleep(backoffMs(attempt));
                continue;
            }
            throw error;
        }

        const body = await readCapped(response);

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

/**
 * `retry-after-ms` wins over `Retry-After`, and either is capped at 60s.
 *
 * Neither header appears in the published API reference — they exist only in the
 * official SDK source, which is why this looks like it could be deleted. It
 * cannot: dropping it makes us ignore the server's own backpressure signal.
 */
function retryAfterMs(headers: Headers): number | undefined {
    const milliseconds = headers.get("retry-after-ms");
    if (milliseconds !== null) {
        const parsed = Number.parseFloat(milliseconds);
        if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, MAX_RETRY_AFTER_MS);
    }

    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
        const seconds = Number.parseFloat(retryAfter);
        // `Retry-After` is either a count of seconds or an HTTP date.
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
            throw new Error(`Jev response exceeded ${MAX_RESPONSE_BYTES} bytes and was abandoned.`);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
