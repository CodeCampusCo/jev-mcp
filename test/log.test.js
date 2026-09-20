import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { drain, logCall, setClient } from "../dist/log.js";

const realFetch = globalThis.fetch;
let sent;

beforeEach(() => {
    sent = [];
    process.env.AXIOM_API_KEY = "axiom-test-token";
    globalThis.fetch = async (url, init) => {
        sent.push({ url, init });
        return new Response("{}", { status: 200 });
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.AXIOM_API_KEY;
    setClient(undefined);
});

/** The events one logCall shipped, split by kind. */
async function shipped() {
    await drain();
    assert.equal(sent.length, 1, "one ingest request per call");
    const events = JSON.parse(sent[0].init.body);
    return { events, call: events[0], answers: events.slice(1) };
}

const OK_BODY = JSON.stringify({
    model: "jev-1.13.0",
    usage: { input_tokens: 120, output_tokens: 8 },
    answers: {
        urgency: { type: "score", score: 2.09, confidence: 0.7, probabilities: { 0: 0.01, 1: 0.2, 2: 0.7, 3: 0.09 } },
        duplicate: { type: "noul", noul: 0.93 }
    }
});

describe("logCall", () => {
    it("ships nothing without a token", async () => {
        delete process.env.AXIOM_API_KEY;

        logCall({ outcome: "ok", startedAt: Date.now(), questions: { a: { type: "noul", instructions: "q" } } });

        await drain();
        assert.deepEqual(sent, []);
    });

    it("writes one call event and one answer event per question asked", async () => {
        setClient({ name: "claude-code", version: "2.0.0" });

        logCall({
            outcome: "ok",
            startedAt: Date.now() - 300,
            state: "a ticket",
            questions: {
                urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
                duplicate: { type: "noul", instructions: "Is this a duplicate?" }
            },
            status: 200,
            attempts: 1,
            body: OK_BODY
        });

        const { call, answers } = await shipped();

        assert.equal(call.event, "call");
        assert.equal(call.outcome, "ok");
        assert.equal(call.status, 200);
        assert.equal(call.attempts, 1);
        assert.equal(call.question_count, 2);
        assert.equal(call.state, "a ticket");
        assert.equal(call.client_name, "claude-code");
        assert.equal(call.client_version, "2.0.0");
        // Read off a copy of the body; the model and usage are the only things kept.
        assert.equal(call.model, "jev-1.13.0");
        assert.equal(call.input_tokens, 120);
        assert.equal(call.output_tokens, 8);
        assert.ok(call.duration_ms >= 300);

        assert.equal(answers.length, 2);
        assert.deepEqual(
            answers.map(a => a.event),
            ["answer", "answer"]
        );
        // Every answer row is joinable back to its call.
        assert.ok(answers.every(a => a.call_id === call.call_id));
    });

    it("never ships the response body, nor the caller's question ids", async () => {
        logCall({
            outcome: "ok",
            startedAt: Date.now(),
            state: "a ticket",
            questions: { urgency: { type: "score", instructions: "How urgent?" } },
            body: OK_BODY
        });

        await drain();
        const raw = sent[0].init.body;
        assert.ok(!raw.includes("urgency"), "the question id means nothing to whoever reads the log");
        assert.ok(!raw.includes("output_tokens\":8,\"answers"), "the body itself is never forwarded");
        assert.ok(!raw.includes("probabilities"));
    });

    it("records the question in words, serialising anything not a string", async () => {
        logCall({
            outcome: "ok",
            startedAt: Date.now(),
            state: { ticket: { id: 7 } },
            questions: {
                colour: { type: "choice", instructions: "Which colour?", criteria: { orange: "It is orange.", black: null } }
            },
            body: JSON.stringify({ answers: { colour: { type: "choice", choice: "orange", confidence: 0.9, probabilities: { orange: 0.88, black: 0.12 } } } })
        });

        const { call, answers } = await shipped();

        // Axiom makes a column per key of a nested object, and these keys are the
        // caller's, so they must arrive as text.
        assert.equal(call.state, '{"ticket":{"id":7}}');
        assert.equal(answers[0].instructions, "Which colour?");
        assert.equal(answers[0].criteria, '{"orange":"It is orange.","black":null}');
        assert.equal(answers[0].choice, "orange");
        assert.equal(answers[0].probability, 0.88);
    });

    it("takes a score's probability from the nearest level", async () => {
        logCall({
            outcome: "ok",
            startedAt: Date.now(),
            state: "s",
            questions: { urgency: { type: "score", instructions: "How urgent?" } },
            body: OK_BODY
        });

        const { answers } = await shipped();

        // 2.09 lands between levels, so there is no exact key for it.
        assert.equal(answers[0].score, 2.09);
        assert.equal(answers[0].probability, 0.7);
    });

    it("logs a rejected call with what it asked and no answer", async () => {
        logCall({
            outcome: "rejected",
            startedAt: Date.now(),
            questions: { a: { type: "noul", instructions: "Is it ready?" } },
            error: "`state` is required: give Jev the material the questions are about."
        });

        const { call, answers } = await shipped();

        assert.equal(call.outcome, "rejected");
        assert.equal(call.question_count, 1, "a rejected call still carries the questions it asked");
        assert.match(call.error, /`state` is required/);
        assert.equal(answers.length, 1);
        assert.equal(answers[0].instructions, "Is it ready?");
        assert.equal(answers[0].type, "noul");
        assert.equal(answers[0].probability, undefined);
    });

    it("stays invisible to the caller when the ingest fails", async () => {
        globalThis.fetch = async () => {
            throw new Error("axiom is down");
        };

        assert.doesNotThrow(() => logCall({ outcome: "ok", startedAt: Date.now(), questions: {} }));
        await assert.doesNotReject(drain());
    });
});
