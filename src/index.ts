#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { callJev, defaultModel } from "./client.js";
import { drain, logCall, setClient } from "./log.js";

const DESCRIPTION = `Ask Jev for a typed judgement about some state, and get it back in roughly 300ms with a calibrated probability attached.

Reach for this mid-task, the way you would read a file, instead of spending a turn reasoning about a bounded question: classifying something, routing between branches, scoring against fixed levels, gating a next step, or checking whether a claim is supported by the text above it.

Do not reach for it for prose, code, a number it would have to compute, or anything whose answer space you cannot enumerate before you ask. Jev writes no text at all. It only chooses: from options you supply (255 at most), from 2-10 ordered levels, or as a probability on a yes/no proposition. Choosing is also how it extracts: find the candidate spans in code with a regex or a parser, ask which one is the answer, and copy that span out yourself. A value it never retypes is a value it cannot invent. It also cannot say "I don't know": forced into a fixed list it will pick something confidently even when nothing fits, so include a "none of these" option whenever one is possible.

Ask several questions in one call whenever you can. They are answered in parallel against the same state, so a question you might not need costs its own tokens and almost no extra time.

Returns the API's JSON response unchanged.`;

// These descriptions are the calling agent's only copy of the API contract.
const JSON_VALUE_TYPES = ["string", "object", "array"];

const EVALUATE: Tool = {
    name: "evaluate",
    description: DESCRIPTION,
    annotations: {
        title: "Evaluate with Jev",
        readOnlyHint: true,
        openWorldHint: true
    },
    inputSchema: {
        type: "object",
        properties: {
            state: {
                type: JSON_VALUE_TYPES,
                description:
                    "The material to judge, as a string, or a JSON object or array. Every question is answered against this same state. Accuracy falls as it fills with material the questions do not need, so filter first and send the fields they actually read. Roughly 32k tokens maximum."
            },
            questions: {
                type: "object",
                minProperties: 1,
                description:
                    "Your questions, keyed by ids you choose. The answers come back under the same ids; the ids are not sent to the model, so name them for your own code. Note that probabilities are not comparable across questions or across question types, so never carry a threshold from one to another.",
                additionalProperties: {
                    type: "object",
                    properties: {
                        type: {
                            type: "string",
                            enum: ["noul", "choice", "score"],
                            description:
                                "noul: a yes/no proposition, answered with a probability between 0 and 1. choice: pick one of up to 255 named options, answered with the option, a probability for each, and a confidence. score: rate against 2-10 ordered levels, answered with the level, probabilities, and a confidence."
                        },
                        instructions: {
                            type: JSON_VALUE_TYPES,
                            description:
                                "What to decide about the state, as a question or an instruction. A string, or a JSON object or array if the question is easier to state structurally."
                        },
                        criteria: {
                            description:
                                'What each possible answer means. The shape depends on `type`. noul (optional): {"true": <what makes it true>, "false": <what makes it false>}. choice (REQUIRED): an object mapping each option name to a description, or to null where the name speaks for itself; 255 options maximum. score (REQUIRED): an ordered array of 2-10 level descriptions, lowest level first.'
                        }
                    },
                    required: ["type", "instructions"]
                }
            },
            model: {
                type: "string",
                description: `The Jev model to use. Defaults to ${defaultModel}.`
            }
        },
        required: ["state", "questions"]
    }
};

function textResult(text: string, isError = false) {
    return { content: [{ type: "text" as const, text }], isError };
}

function questionMap(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function main(): Promise<void> {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
        console.error("TYPESAFE_API_KEY is not set. Put it in a .env file in the jev-mcp directory (see .env.example), or export it in the environment jev-mcp runs in.");
        process.exit(1);
    }

    const server = new Server({ name: "jev-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [EVALUATE] }));

    server.setRequestHandler(CallToolRequestSchema, async request => {
        if (request.params.name !== EVALUATE.name) {
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // Only known once the client has sent `initialize`, so read per call.
        setClient(server.getClientVersion());

        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        // Read before the checks, so a call rejected for a missing state still
        // logs the questions it carried rather than a question_count of 0.
        const asked = questionMap(args.questions);
        const reject = (message: string) => {
            logCall({ outcome: "rejected", startedAt, state: args.state, questions: asked, error: message });
            return textResult(message, true);
        };

        // The only two checks; the API rejects everything else.
        if (args.state === undefined || args.state === null) {
            return reject("`state` is required: give Jev the material the questions are about.");
        }
        if (!asked || Object.keys(asked).length === 0) {
            return reject("`questions` must be a non-empty object mapping your own question ids to questions.");
        }

        const payload = { model: args.model ?? defaultModel, state: args.state, questions: asked };

        try {
            const { ok, status, body, attempts } = await callJev(apiKey, payload);
            logCall({ outcome: ok ? "ok" : "api_error", startedAt, state: args.state, questions: asked, status, attempts, body });

            if (!ok) {
                return textResult(`Jev API error (HTTP ${status}): ${body || "<empty response body>"}`, true);
            }

            return textResult(body);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logCall({
                outcome: "transport_error",
                startedAt,
                state: args.state,
                questions: asked,
                attempts: (error as { attempts?: number })?.attempts,
                error: message
            });
            return textResult(`Could not reach the Jev API: ${message}`, true);
        }
    });

    process.on("SIGTERM", () => void drain().then(() => process.exit(0)));

    await server.connect(new StdioServerTransport());
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
