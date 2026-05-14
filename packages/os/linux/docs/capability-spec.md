# Capability bus specification

> Status: scaffold. Lock in [`PLAN.md`](../PLAN.md#capabilities). Implementation in
> milestone #11 (first canonical app).

The capability bus is the *only* path generated apps have to anything outside their
sandbox. Locked decision #14: there is no shared `cap.sock` — each running app gets
its own bind-mounted socket at `/run/eliza/cap-<slug>.sock`. The socket path
identifies the caller; cross-app impersonation is impossible by construction.

## Threat model

The agent is trusted. Generated apps are not. Apps are arbitrary code from a
hallucination-prone LLM and must be treated like browser JS — sandboxed by default,
deny-by-default on every cap-bus method.

| Threat | Mitigation |
|---|---|
| App A reads App B's `data/` | Per-app socket; bind-mount of `cap-<slug>.sock` only; the broker rejects requests on a socket it didn't open for that slug |
| App spoofs another app's identity | Connection authentication is the socket *path* itself — `elizad` knows which app owns each socket from creation time |
| App calls a capability it didn't declare | Broker checks the manifest's declared capability list before dispatch; returns `error_code::CAPABILITY_NOT_GRANTED` (-32000) on undeclared calls |
| App escapes bubblewrap via a buggy capability | Each capability has a per-cap seccomp profile; the bubblewrap profile builder in `eliza-sandbox` produces minimal binds for each declared cap |

## v1 surface

See `eliza_types::Capability` for the canonical enum. The serialized form is a
JSON object `{"kind": "<name:purpose>", ...params}`.

## JSON-RPC envelope

The protocol is JSON-RPC 2.0 over newline-delimited frames on the Unix socket.
See `eliza_cap_bus::{Request, Response, RpcError}`.

This document expands as milestone #11 implements `time:read` and `storage:scoped`.
