import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { callJev } from "../dist/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Replays `responses` in order, recording every request it was called with. */
function stubFetch(responses) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const next = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (typeof next === "function") return next();
        return next;
    };
    return calls;
}

describe("callJev", () => {
    it("returns the body unchanged, without parsing it", async () => {
        // Key order and whitespace survive: the caller gets what the API sent.
        const raw = '{"model":"jev-1.13.0",  "answers":{"a":{"type":"noul","noul":0.82}}}';
        stubFetch([() => new Response(raw, { status: 200 })]);

        const result = await callJev("key", { state: "s", questions: {} });

        assert.deepEqual(result, { ok: true, status: 200, body: raw, attempts: 1 });
    });

    it("sends the key as a bearer token and the payload as JSON", async () => {
        const calls = stubFetch([() => new Response("{}", { status: 200 })]);

        await callJev("sk-test", { model: "jev-1.13.0", state: "s" });

        const { init } = calls[0];
        assert.equal(init.method, "POST");
        assert.equal(init.headers.authorization, "Bearer sk-test");
        assert.equal(init.headers["content-type"], "application/json");
        assert.deepEqual(JSON.parse(init.body), { model: "jev-1.13.0", state: "s" });
    });

    it("does not retry a 400", async () => {
        const calls = stubFetch([() => new Response("bad request", { status: 400 })]);

        const result = await callJev("key", {});

        assert.equal(calls.length, 1);
        assert.deepEqual(result, { ok: false, status: 400, body: "bad request", attempts: 1 });
    });

    it("retries a 429 and honours retry-after-ms", async () => {
        const calls = stubFetch([
            () => new Response("slow down", { status: 429, headers: { "retry-after-ms": "5" } }),
            () => new Response('{"ok":true}', { status: 200 })
        ]);

        const startedAt = Date.now();
        const result = await callJev("key", {});

        assert.equal(calls.length, 2);
        assert.equal(result.attempts, 2);
        assert.equal(result.body, '{"ok":true}');
        // The header won over the ~500ms backoff the attempt would otherwise take.
        assert.ok(Date.now() - startedAt < 400, "retry-after-ms should shorten the wait");
    });

    it("gives up after two retries and returns the last response", async () => {
        const calls = stubFetch([() => new Response(null, { status: 503 })]);

        const result = await callJev("key", {});

        assert.equal(calls.length, 3);
        assert.deepEqual(result, { ok: false, status: 503, body: "", attempts: 3 });
    });

    it("retries a transport failure, then throws with the attempt count", async () => {
        const calls = stubFetch([
            () => {
                throw new Error("socket hang up");
            }
        ]);

        const error = await callJev("key", {}).then(
            () => undefined,
            e => e
        );

        assert.equal(calls.length, 3);
        assert.equal(error.message, "socket hang up");
        assert.equal(error.attempts, 3);
    });

    it("abandons an oversized response without retrying it", async () => {
        const megabyte = new Uint8Array(1024 * 1024);
        const calls = stubFetch([
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            for (let i = 0; i < 5; i++) controller.enqueue(megabyte);
                            controller.close();
                        }
                    }),
                    { status: 200 }
                )
        ]);

        const error = await callJev("key", {}).then(
            () => undefined,
            e => e
        );

        assert.equal(calls.length, 1, "an oversized response is not worth asking for again");
        assert.match(error.message, /exceeded 4194304 bytes/);
        assert.equal(error.attempts, 1);
    });
});
