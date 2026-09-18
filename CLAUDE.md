# jev-mcp — working notes

An MCP server exposing one tool, `evaluate`, that forwards a typed question to the TypeSafe Jev API
and returns the response unchanged. TypeScript, Node, no vendor SDK.

## The one rule that shapes everything

**This is a passthrough.** It validates the request shape, calls the API, and hands the raw JSON
back. It does not parse answers, reshape them, add fields, or summarise. Anything that interprets a
probability belongs in the caller, not here.

## Decisions already made — don't relitigate without a reason

**Plain `fetch`, not `@typesafe-ai/sdk`.** A passthrough never reads the typed response, so the SDK's
main benefit is unused, and its 0.x releases have already shipped one breaking change. The JS SDK
also crashes Node 20 and 22 on handled cancellation via its bundled Undici.

**Reimplement the SDK's retry behaviour, not a simpler one.** Match it: up to 2 retries, 500ms
growing to 5s, 0.25 jitter, retry on 408, 429, 529 and 5xx. Prefer the **`retry-after-ms`** response
header over `Retry-After`, capped at 60s. Neither header appears in the published API reference —
they are only in the SDK source, so they are easy to miss and worth a comment in the code.

**The tool description is load-bearing.** It is the only thing telling an agent when to reach for
this and when not to. It must say that the answer space has to be enumerable up front and that Jev
produces no prose, code, or free-form text. Treat changes to it as behaviour changes.

## Contributing

`main` is protected: every change lands through a PR, including your own. Self-merge is fine.

Keep plans, scratch notes and premortems out of the repository — gitignore them.
