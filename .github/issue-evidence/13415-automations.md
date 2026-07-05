# #13415 — cloud-shared fallback sweep slice 7: platform-automation connectors

Areas: twitter/telegram/discord/whatsapp-automation, agent-google-connector, shared-runtime.
Verified untouched by every in-flight fallback-sweep branch at file level before starting.

## Changed (behavioral fail-closed / annotation)

| file | verdict summary |
|---|---|
| discord-automation/index.ts | fail-closed fixes: swallowed Discord API failures on send/fetch now propagate as typed failures; J-annotations; console→logger |
| shared-runtime/run-shared-agent-turn.ts | fail-closed fixes on the shared agent-turn REST path |
| telegram-automation/index.ts, twitter-automation/{app-automation,index}.ts | J1/J4/J6/J7 annotations on already-fail-closed boundary/teardown/enrichment catches |
| whatsapp-automation/index.ts, agent-google-connector/shared.ts | fail-closed fixes / annotations |
| telegram/twitter/discord app-automation generate* catches | **money-path-flagged** — refundCredits+rethrow, left untouched |

Connectors were mostly already fail-closed (translate a failed platform send into a typed `Result{success:false,error}` callers branch on); this slice adds the grep-able `// error-policy:J<N>` annotations, a few real fail-closed fixes (discord/shared-runtime), and error-path tests.

## Verification
- 72 new error-path `bun:test` suites pass under `--isolate` (the CI invocation); driving the real exported send/receive/exchange functions, proving internal-failure PROPAGATES vs designed-empty ("not connected", empty inbox) stays distinguishable.
- existing automation suites: 107 pass / 0 fail (no regression).
- `biome check` clean; `audit:error-policy-ratchet` → "no new fallback-slop".
- Money guard: every credit/refund/promotion-pricing path left untouched and flagged.

## N/A
UI screenshots / model trajectories / audio — N/A (server connector services). Runtime logs — N/A - service unit boundary only (behavior proven by error-path tests).
