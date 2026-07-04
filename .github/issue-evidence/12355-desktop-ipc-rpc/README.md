# #12355 — Desktop local-agent IPC: Electrobun RPC + IPC api-base + no-listener proof

Phase 2 of #12180, building on the merged #12293 foundation slice (shared stdio
kernel, port-gating, dormant desktop resolver).

## What this slice lands (main-process side, fully unit-tested, non-breaking)

| Piece | File |
|---|---|
| IPC-mode gate + `eliza-local-agent://ipc` api base | `packages/app-core/platforms/electrobun/src/api-base.ts` |
| `localAgentRequest` / `localAgentStreamRequest` RPC schema + stream push events | `.../src/rpc-schema.ts` |
| Buffered request handler (path validation, dispatcher seam) | `.../src/local-agent-request.ts` |
| Main-process NDJSON stdio client codec | `.../src/local-agent-stdio-dispatcher.ts` |
| Child-stdio → dispatcher attach + process-wide registry | `.../src/local-agent-stdio-attach.ts`, `.../src/local-agent-dispatcher-registry.ts` |
| Handler registration | `.../src/rpc-handlers.ts` |

Default boot (no `ELIZA_DESKTOP_LOCAL_AGENT_IPC`) is byte-for-byte identical to
today: loopback HTTP api base, port bound, renderer never addresses the IPC base
so the handler is unreachable. `ELIZA_API_EXPOSE_PORT=1` always wins and keeps
the loopback HTTP path (dev tooling / LAN / e2e harnesses).

## Evidence

| Artifact | File |
|---|---|
| Electrobun unit tests — api-base IPC switch, stdio dispatcher, attach/registry, request handler (50 pass) | `electrobun-unit-tests.txt` |
| No-TCP-listener proof — real child harness asserts the agent port is NOT bound with `skipListen`, IS bound without it (#12293 primitive, 9 pass) | `agent-skip-listen-no-port-proof.txt` |

## Device-gated remainder (needs a real desktop; cannot be proven headlessly)

The behavior-flipping child-side pieces + `PR_EVIDENCE.md` desktop captures:

- Child `eliza start` honoring `localAgentMode` + running the NDJSON stdio server
  (kernel exists as `createStdioBridge`; the child entry does not yet read an env
  to enable it, so the main-process spawn flip is not wired — attaching the
  bridge to a child that does not speak it would be broken).
- `AgentManager` spawn flip: `stdin: "pipe"`, `attachLocalAgentStdioBridge`, and
  IPC-native readiness (today's readiness/health poll assumes an HTTP port).
- `localAgentStreamRequest` child-side streaming consumer (the handler throws
  loudly until it lands).
- `bun run --cwd packages/app capture:linux-desktop` / `capture:windows-desktop`,
  `lsof -iTCP -sTCP:LISTEN -n | grep -E '31337|2138'` printing nothing in IPC
  mode, main-process logs of `localAgentRequest`, frontend network trace with
  zero `127.0.0.1` agent calls.
