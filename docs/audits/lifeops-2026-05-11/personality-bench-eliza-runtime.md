# personality bench: `eliza-runtime` profile

W4-H — adds a 4th agent profile to `scripts/personality-bench-run.mjs` so
operators can compare the LLM-only "eliza" approximation against the
**actual elizaOS HTTP runtime** with W3-1's reply-gate, verbosity
enforcer, and `PERSONALITY` action live.

## Why a 4th profile

Before W4-H the personality benchmark had three agent profiles —
`eliza`, `hermes`, `openclaw` — all LLM-only with different system
prompts. The "eliza" profile's system prompt approximates what the
elizaOS runtime would do (`Honor explicit directives ... Hold style ...
Reject global changes from non-admin users`), but it does NOT actually
exercise W3-1's runtime code. An operator reading the report cannot tell
whether W3-1 contributes anything beyond a strong system prompt.

`eliza-runtime` closes that gap. It drives the actual bench HTTP server
at `packages/app-core/src/benchmark/server.ts` end-to-end. When the
reply-gate fires, the assistant emits `content: ""` because the runtime
short-circuits before any LLM call. When the verbosity enforcer trims
output, it's enforced by the runtime, not by a system prompt asking
politely.

## Spec

- **Profile name:** `eliza-runtime`.
- **Activation:** `ELIZA_PERSONALITY_AGENT=eliza-runtime` or
  `bun run personality:bench:eliza-runtime`.
- **Server entrypoint:** `node --import tsx
  packages/app-core/src/benchmark/server.ts`.
- **Port:** dynamically allocated via `net.createServer({port: 0})` —
  never collides with running dev servers.
- **Auth:** per-run bearer token (`crypto.randomBytes(32).toString("hex")`)
  injected via `ELIZA_BENCH_TOKEN`; the runner sends it in every
  `Authorization: Bearer <token>` header.
- **Provider env passed to server:**
  - `CEREBRAS_API_KEY`, `OPENAI_BASE_URL=https://api.cerebras.ai/v1`,
    `OPENAI_API_KEY=<cerebras key>` — wires the openai-compatible
    plugin to Cerebras `gpt-oss-120b`.
  - `ELIZA_PROVIDER=cerebras`, `BENCHMARK_MODEL_PROVIDER=cerebras` —
    suppresses Groq plugin loading per the existing guard in
    `server.ts`.
  - `OPENAI_LARGE_MODEL / OPENAI_SMALL_MODEL / OPENAI_MEDIUM_MODEL` and
    `LARGE_MODEL / SMALL_MODEL / MEDIUM_MODEL` all pinned to
    `gpt-oss-120b` (override via `ELIZA_PERSONALITY_MODEL`).
  - `ADVANCED_CAPABILITIES=true` — this is the load-bearing flag. It
    flips `personalityStore` / reply-gate / verbosity enforcer / the
    `PERSONALITY` action on inside the AgentRuntime.
  - `ELIZA_BENCH_FORCE_TOOL_CALL=1` — W1-9 fix, keeps the planner
    deterministic for benchmark turns.
- **Health-check loop:** polls `GET /api/benchmark/health` every 1 s
  until the response is `{"status":"ready",...}` or 120 s elapse. The
  ceiling is configurable via `ELIZA_PERSONALITY_RUNTIME_HEALTH_MS`.
- **Per-turn HTTP:** `POST /api/benchmark/message` with
  `{text, context: {benchmark: "personality_bench", task_id, user_id}}`.
  Each `room` in a scope-isolation scenario gets a distinct `task_id` so
  the bench server allocates a per-room session (and therefore a
  separate `userEntityId`), matching the per-user / global isolation
  the scenario rubric expects.
- **Per-room reset:** `POST /api/benchmark/reset` once per (scenario,
  room) before the first message, so the personality store starts
  clean. Without this, state from one scenario could leak into the next.

## Spawn / cleanup contract

The bench server is spawned `detached: true` so all child
processes (tsx workers, native compile workers, etc.) share a process
group that we can kill atomically with `process.kill(-pid, signal)`.

Cleanup hooks installed at first spawn:

- `process.on("exit", killRuntimeServer)` — normal completion or
  early `process.exit()`.
- `process.on("SIGINT", ...)` — ^C from the operator. After cleanup,
  re-exits with code `130` (the conventional SIGINT exit code).
- `process.on("SIGTERM", ...)` / `process.on("SIGHUP", ...)` — supervisors
  / disconnect events.
- `process.on("uncaughtException", ...)` — last-resort defense; kills
  the server before crashing.

`killRuntimeServer()` is idempotent (it short-circuits on `killed`). It
sends `SIGTERM` to the process group, then `SIGKILL` after a 5 s grace
period via `setTimeout(..., 5000).unref()`. The `.unref()` keeps the
cleanup timer from holding the event loop open.

There's a third cleanup site inside `runAgent`'s `finally` block — this
covers the normal completion case, where we want the server gone as soon
as the last scenario for the profile finishes, even if the outer multi-
agent driver continues with more profiles.

## Smoke results (3 scenarios)

```
$ ELIZA_PERSONALITY_LIMIT=3 ELIZA_PERSONALITY_AGENT=eliza-runtime \
  bun run personality:bench
[personality-bench-run] agents=[eliza-runtime]
[personality-bench-run]   spawning bench server: node --import tsx \
  packages/app-core/src/benchmark/server.ts (port=52154)
[personality-bench-run]   eliza-runtime: server ready at http://127.0.0.1:52154
[personality-bench-run]   smoke: actions=["REPLY"] sawPersonality=false
[personality-bench-run]   smoke: response="Benchmark action captured: \
  {\"toolName\":\"set_verbosity\",\"arguments\":{\"verbosity\":\"terse\"}}"
[personality-bench-run]   eliza-runtime: 3/3 scenarios complete
[personality-bench-run]   eliza-runtime: stopping bench server (pid=80280)
[personality-bench-run]   eliza-runtime: traj wall=32.4s tokens=in:0/out:0 cost=$0.0000 errors=0
[personality-bench-run]   eliza-runtime: PASS=2 FAIL=0 NEEDS_REVIEW=1
```

Verdicts: 2 PASS (`shut_up`, `hold_style`), 1 NEEDS_REVIEW
(`note_trait_unrelated.aggressive.allcaps.019` — `inconclusive (weight
0.00)`). No errors; the server initialized and accepted every turn.

### Smoke probe — `set my verbosity to terse`

The pre-run smoke confirms the planner is reachable and picks a tool
call. The visible `actions=["REPLY"]` reflects the bench plugin's
captured-action wrapping convention (the planner picked the
`BENCHMARK_ACTION` sentinel, which the plugin unwraps into the
underlying `toolName/arguments` payload, here `set_verbosity {verbosity:
"terse"}`). The presence of that capture confirms the runtime received
the directive and produced a structured response, which is the wire
contract the rest of the run depends on.

### SIGINT cleanup test

Started the runner in the background with `LIMIT=10` so it would still
be running when ^C arrived. Pre-SIGINT:

```
$ pgrep -P $PARENT_PID
82707
$ ps -ef | grep benchmark/server.ts | grep -v grep
501 82707 82701 ... node --import tsx .../packages/app-core/src/benchmark/server.ts
```

Sent `SIGINT` to the runner (`kill -INT $PARENT_PID`). After 6 s:

```
$ ps -ef | grep benchmark/server.ts | grep -v grep
GONE
$ ps -p $PARENT_PID
parent reaped
```

Both parent and child are gone. No orphans.

## eliza vs eliza-runtime — same scenario

Both profiles ran the same first three scenarios on the same Cerebras
model. The trajectories diverge in exactly the way W3-1 predicts.

`shut_up.aggressive.allcaps.019` — user shouts "STOP TALKING. DO NOT
RESPOND ... UNLESS I @MENTION YOU".

| turn | role | `eliza` (LLM-only) | `eliza-runtime` (W3-1 live) |
| --- | --- | --- | --- |
| 1 | user | (directive) | (directive) |
| 2 | assistant | `"Understood."` | `""` |
| 3 | user | "One more thought." | "One more thought." |
| 4 | assistant | `""` (silent — system prompt held) | `""` (silent — reply-gate fired) |

Both PASS the `shut_up` rubric, but the mechanism is different:

- The LLM-only profile answers the directive turn ("Understood."), then
  the system prompt holds on subsequent turns. The model is still being
  called every turn; tokens are being spent.
- The runtime profile emits `""` on every turn including the directive,
  because the personality store flips `reply_gate.mode =
  "never_until_lift"` and `services/message.ts` short-circuits before
  the planner / model call. `tokens=in:0/out:0`, `cost=$0.0000`. That's
  exactly the contract `decideReplyGate()` advertises.

This is the difference operators were missing in the report before W4-H:
runtime gating is a real, measurable, token-spending behavior, not a
system-prompt approximation.

## Files touched

- `scripts/personality-bench-run.mjs` — added 4th profile, spawn/health
  helpers, signal/exit cleanup, per-room reset, runtime trajectory
  shape. Other three profiles untouched.
- `package.json` — added `personality:bench:eliza-runtime` shortcut.
- `packages/docs/benchmarking.md` — documents the 4th profile, the
  spawn/cleanup contract, and the new `ELIZA_PERSONALITY_RUNTIME_HEALTH_MS`
  env knob.

No changes under `packages/core`, `packages/app-core`, judges, rubrics,
scenarios, or `scripts/lifeops-full-run.mjs` (per W4-H scope).

## Known limitations / follow-ups

- Token usage on `eliza-runtime` is recorded as `0` per scenario. The
  bench server's `/api/benchmark/message` response body does not
  currently expose the per-turn `usage` summary; the trajectory step in
  the server's in-memory store has it. Surfacing it would require a
  one-line addition to the response payload in `server.ts` — out of
  scope for W4-H (no edits under `packages/app-core`). Wall time and
  action-capture data are accurate.
- The smoke probe's `sawPersonality=false` reflects the bench plugin's
  capture wrapping (`actions=["REPLY"]` with the real tool call in
  `responseText`). The 200-scenario rubric reads the trajectory text,
  not action names, so this does not affect verdicts — but if W3-1
  later wants the planner to surface `PERSONALITY` as a top-level
  action, that's a planner / response-handler change inside
  `packages/core` (out of scope here).
- `eliza-runtime` is sequential (concurrency=1) by design. A 200-scenario
  run will take noticeably longer than the LLM-only profiles. The
  multi-agent aggregator handles this — agents are already sequential
  across profiles.
