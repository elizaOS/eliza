# Discord provider-canary operator readiness

The Discord operator module is intentionally a preflight and read-only
collection boundary, not a production canary executor. It validates the signed
manifest authorization, exact guild/channel target, exact message input, and
both raw negative-probe definitions before making a network request. Its only
provider call is Discord REST `GET /channels/{channel_id}/messages` using a bot
credential supplied in memory.

Ingress must be a real message authored by the configured human operator in the
configured private channel. The message must contain the signed run nonce and
match the complete configured content. A bot-authored copy is rejected; the
controller never posts a message or uses a Discord self-bot. The subsequent
provider effect must be a distinct, later message authored by the configured
agent bot with the exact signed operation text.

The returned readback retains raw private message content for the operator and
sets `qualificationClaimed: false`. It is not observer evidence, a signature, a
semantic verdict, replay proof, failure-path proof, or a publishable artifact.
Do not place the raw output or the Discord bot token in the repository.

## Current hard blockers

`preflightDiscordOperatorCanary` always reports these repository-level gaps,
and `assertDiscordOperatorCanaryExecutable` refuses execution:

- no authenticated deployed-agent endpoint exports the canonical trajectory
  set for the exact external Discord ingress;
- no supported operator path replays the exact authenticated Discord gateway
  event without bot/self-bot injection; and
- no independent executor runs the signed authorization-denial and
  provider-rejection probes and captures before/after provider state.

These fields remain explicit `null` values in the closed operator plan. A URL,
boolean, or ad hoc script is rejected rather than treated as evidence. To make
the canary executable, first add documented authenticated contracts at the
deployed gateway/agent and independent observer boundaries, including contract
tests and retained real-path evidence. Then version this plan and replace the
blockers with validators for those concrete contracts. Do not weaken or remove
the refusal while any path is unavailable.

