# jev-mcp

An MCP server that gives a coding agent one tool: **ask Jev a typed question and get a short answer
back.**

[Jev](https://typesafe.ai) is a model that generates no text. You hand it some state plus typed
questions; it returns a decision for each one with a calibrated probability. Answers come back in
roughly 300ms.

This server exists so an agent can reach for that mid-task — the same way it reaches for a file read
— instead of spending a turn reasoning about a question whose answer space is three words wide.

## What it is for

Small judgments that are bounded and that you would otherwise think about:

- *Are these two things really two things, or one?*
- *Which of these four categories does this belong to?*
- *Is this claim supported by the text above it?*

And what it is **not** for: anything that needs prose, code, a number it has to compute, or an answer
you cannot enumerate in advance. Jev writes nothing. It only chooses.

## Install

```sh
npm install
npm run build
```

Then register it with your agent. For Claude Code:

```sh
claude mcp add jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

Put your key in a `.env` next to this README:

```sh
cp .env.example .env
```

The server reads that file at startup, resolved against its own directory rather than wherever
your agent happened to launch it from. The key stays with the server instead of being written
into your agent's configuration. An exported `TYPESAFE_API_KEY` still works and wins over the
file, so a one-off run can override it.

Two overrides exist and are rarely needed, in the environment or in the same file:
`TYPESAFE_API_URL` points the server at a different endpoint, and `TYPESAFE_DEFAULT_MODEL`
changes the model used when a call does not name one.

## The tool

One tool, `evaluate`. It takes the state to judge and a map of questions, and returns the API's
response unchanged.

```jsonc
{
  "state": "The cat sat on the mat. It is a large orange tabby.",
  "questions": {
    "colour": {
      "type": "choice",
      "instructions": "What colour is the animal?",
      "criteria": { "orange": "The animal is orange.", "black": "The animal is black." }
    },
    "large": {
      "type": "noul",
      "instructions": "Is the animal large for its species?"
    }
  }
}
```

### Question types

| type | ask it | returns |
|---|---|---|
| `noul` | a yes/no proposition | a probability between 0 and 1 |
| `choice` | pick one of up to 255 options | the option, a probability for each, and a confidence |
| `score` | rate against 2–10 ordered levels | the level, probabilities, and a confidence |

`criteria` is optional for `noul` (`{"true": …, "false": …}`), required for `choice` (a map of option
name to description), and required for `score` (an ordered array of at least two level
descriptions).

Ask several questions in one call whenever you can. They are answered in parallel against the same
state, so a question you might not need costs its own tokens and almost no extra time.

## Things worth knowing before you use it

**It cannot say "I don't know."** Forced into a yes/no or a fixed list, it will pick something even
when nothing fits, and it will pick confidently. Include a "none of these" option whenever one is
possible.

**It does not count and it does not do arithmetic.** It reads dates as text, not as quantities that
come before or after each other. Keep all of that in your own code.

**Accuracy falls as the state fills with material the question does not need.** Filter first; send
the fields the question actually reads.

**Probabilities are not comparable across questions.** The same question asked as a `noul` and as a
yes/no `choice` can disagree, and a question and its negation need not sum to one. Never carry a
threshold from one question type to another.

**Limits.** 255 options per choice, 10 levels per score, roughly 32k tokens of state and 64k for the
whole request.

## Logging

Optional, and off unless you set it. Put an Axiom ingest token in `AXION_API_KEY` and every call is
shipped to the `jev-mcp` dataset. With no token nothing is sent and nothing else changes, so a clone
does not need an Axiom account.

**It logs the questions, never the state.** What you asked is recorded — the instructions and the
criteria — because a probability you cannot attribute to a question is not worth much. What you
asked it *about* is not: no state, no response body, no API error body. The state never reaches the
logging code at all, and the response is read for scalars and then dropped, so an error body that
quotes your input back cannot leak through that route either.

The split is deliberate. A question is something you wrote; a state is whatever an agent happened to
be holding when it called.

Each call writes one `call` event — hostname, outcome, duration, HTTP status, how many attempts it
took, the model that answered, token counts, question count — and one `answer` event per question,
carrying the type, the value chosen, the confidence, and the probability Jev put on the answer it
gave.

For provenance, `hostname` answers which machine and `server_instance_id` answers which run: MCP's
`initialize` carries no session id, so that is an id for this server process, and since a stdio
server is spawned per client it separates concurrent sessions on one machine. The client's own
`client_name` and `client_version` are recorded as it reports them.

Those `answer` rows are the point. Probability and confidence as queryable columns, accumulated
across real traffic, are a calibration curve for Jev on your own data — the one thing you cannot get
from the vendor. Group them by `question_hash`, not `question_id`: the id is whatever the caller
typed and collides freely between unrelated calls, while the hash covers the type, the instructions
and the criteria, and is stable however the caller ordered those keys. There is a row per question
*asked*, so a call the API rejected still records what was asked of it.

`instructions` and `criteria` are stored as text, serialised when they are not already a string.
Axiom turns each key of a nested object into a dataset column, and those keys would be the caller's
option names — so left nested, any agent could add permanent columns to the schema just by naming an
option, and the fields describing how the server behaves would end up buried under them.

Failures are logged as well as successes, since a log of only what worked hides the pattern worth
finding. A rejected request, a non-2xx with its status, a timeout with the number of attempts it
burned, an oversized response.

It cannot delay or break a call: the write is not awaited and every failure inside it is swallowed,
so Axiom being down, slow or misconfigured is invisible to the caller.

Shutdown is the one place it waits, and only there. An MCP client ends stdin, gives the server two
seconds, then sends `SIGTERM` — which Node acts on immediately. A cold ingest takes about 2.6s from
Bangkok against 275ms warm, nearly all of it TLS, so the first write of a server that is closed soon
after its call would never land, and would fail silently. `SIGTERM` therefore drains what is already
in flight, capped at 1.5s so it stays inside the window before the client escalates to `SIGKILL`.
That is the only wait in the whole path, and the response is long gone by then.

## Design

The server is a passthrough. It does not interpret the response, reshape it, or summarise it — the
raw JSON goes back to the caller, so probabilities arrive intact and any field the API adds later
passes through without a change here.

It talks to the API over plain `fetch` rather than a vendor SDK. The request surface is a single
endpoint with three question types, and a passthrough gets no benefit from typed responses it never
reads. Retry behaviour is reimplemented deliberately, matching the official SDKs including the
`retry-after-ms` header that is not in the published API reference.

## Licence

MIT.
