# Contributing

Thanks for looking. This is a small project, deliberately so: one tool, three source files, one
dependency. Most of what follows exists to keep it that way.

## Getting set up

```sh
npm install
npm test
```

`npm test` builds first, so it is also the check that a change compiles. The tests stub `fetch` and
never touch the network, so you can run the whole suite without an API key or an Axiom account.

To try a change against the real API, put a TypeSafe key in `.env` (see the [README](README.md#setup))
and point your agent at `dist/index.js`.

## The rule that shapes everything

**This server is a passthrough.** It validates the request shape, calls the API, and hands the raw
JSON back. It does not parse answers, reshape them, add fields, or summarise. Anything that
interprets a probability belongs in the caller.

Changes that make the server smarter about the response are the ones most likely to be turned down,
however useful they look.

## Decisions already made

These were argued once. Reopen them if you have a reason, but bring the reason.

**Plain `fetch`, not `@typesafe-ai/sdk`.** A passthrough never reads the typed response, so the SDK's
main benefit is unused, and its 0.x releases have already shipped one breaking change.

**The retry behaviour matches the official SDKs on purpose:** up to 2 retries, 500ms growing to 5s,
0.25 jitter, retry on 408, 429, 529 and 5xx, preferring the `retry-after-ms` header over
`Retry-After`. Neither header is in the published API reference; they exist only in the SDK source,
so the code that reads them looks dead and is not. Do not simplify it.

**The tool description is load-bearing.** It is the only thing telling an agent when to reach for
this tool and when not to, and it is the only copy of the API contract the agent ever sees. Treat an
edit to it as a behaviour change, not a wording change.

**No new dependencies without a reason that survives a second look.** There is one runtime
dependency and it is the MCP SDK.

## Style

There is no formatter and no linter. Match the file you are editing: four-space indent, double
quotes, semicolons, generous line length.

Comments earn their place by changing what a reader would do: a constraint, a gotcha, why the
obvious simpler thing is wrong. Narrating what the next line does is noise.

## Tests

Node's built-in runner, in `test/`, exercising the exported surface rather than internals. A change
to how the server retries, what it logs, or what it rejects should come with a test that fails
without it.

## Pull requests

`main` is protected: every change lands through a PR, including the maintainer's. No agent merges its
own work.

- One concern per PR.
- `npm test` passes. CI runs it on Node 20.12, 22 and 24.
- Say what changed and why it is the right shape, not what the diff already shows.
- Keep plans, scratch notes and premortems out of the repository. They are gitignored, so leave
  them that way.

## Reporting something instead

A bug or a question is at least as welcome as a patch, so [open an
issue](https://github.com/CodeCampusCo/jev-mcp/issues). For anything security-shaped, read
[SECURITY.md](SECURITY.md) first and do not open a public issue.
