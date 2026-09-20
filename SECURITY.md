# Security

## Reporting a vulnerability

Report it privately through GitHub: **[open a draft security
advisory](https://github.com/CodeCampusCo/jev-mcp/security/advisories/new)**. Please do not open a
public issue for anything security-shaped.

Tell us what you can reach and how, and give us a way to reproduce it. You should hear back within a
week. Only the tip of `main` is supported; there are no maintained older versions to backport to.

## What leaves your machine

This server is a pipe to someone else's API. It stores nothing, so the question worth asking is
what it sends, and where.

**To the TypeSafe API, on every call:** the `state` and the `questions` exactly as your agent sent
them, plus your API key as a bearer token. The endpoint is `https://api.typesafe.ai/v1/systemone`
unless `TYPESAFE_API_URL` says otherwise. Whatever your agent had in its context when it decided to
ask goes with it, so treat the tool as an outbound channel.

**To Axiom, only if you set `AXIOM_API_KEY`:** the `state`, the `instructions` and the `criteria` of
every call, plus your machine's hostname, the client's name and version, timings, HTTP status and the
answers. This is deliberate, on the grounds that a log you cannot replay from is not worth keeping,
but it means the same content reaches a second service. Leave `AXIOM_API_KEY` unset and nothing is sent anywhere but
the API. The [README](README.md#logging) describes exactly what each event carries.

Nothing is written to disk, and nothing is sent to us.

## Handling your keys

`TYPESAFE_API_KEY` is the credential worth protecting; an Axiom ingest token is write-only but still
worth treating as a secret.

- Keep both in `.env` at the package root. It is gitignored, and it must stay that way.
- Prefer `.env` over your agent's config file. Those are often world-readable, sometimes synced, and
  frequently pasted into bug reports.
- The key is only ever sent to `TYPESAFE_API_URL` as an `Authorization` header. It is never logged,
  not in telemetry and not in an error message.
- An API error body is passed back to the caller verbatim, so it lands in your agent's transcript.
  It should not contain your key, but it will usually contain your input.

If a key does leak, rotate it at the provider; nothing in this repository needs changing.

## Scope

This is a stdio MCP server. It trusts whoever spawned it and whatever that process sends: an agent
that can call `evaluate` can send anything it holds to the API, by design. The trust boundary is
around your agent, not inside this server.

Two things are worth knowing about how it behaves under load or attack from the far side:

- A response larger than 4MB is abandoned rather than buffered, so a hostile or broken endpoint
  cannot exhaust memory through it.
- Every request has a 10s deadline and at most three attempts, so a hanging endpoint fails in about
  31s instead of never.

Anything reachable only by an agent that already has your key and your filesystem is not a
vulnerability in this server.
