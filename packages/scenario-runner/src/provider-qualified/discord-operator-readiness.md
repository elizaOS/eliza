# Discord provider-canary operator readiness

The Discord operator module is a preflight, deployed-capability, and read-only
collection boundary. It validates the signed
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

## Deployed capability contract

The repository now defines a closed deployed-capability contract for:

- authenticated ingress with an exact request hash and correlation handle;
- isolated trajectory export verified from real run-directory bytes;
- correlated authenticated replay with unchanged effect counts;
- both exact manifest-bound failure probes with unchanged provider state; and
- explicit cleanup or a durable reconciliation-required handoff.

The plan carries a self-hashed descriptor bound to the signed manifest's run,
deployment, HTTPS ingress origin, operation hash, and complete failure-probe
hash set. `assertDiscordOperatorCanaryExecutable` returns an executable seam
only when all five functions are present as plain data properties. Missing,
accessor-backed, or additional capabilities fail before ingress. Returned
receipts must echo every binding and pass chronology checks; trajectory content
is recomputed by `verifyScenarioTrajectories`.

This contract does not make a deployment available. Operators must inject real
production implementations and independently retain their credentials,
observer keys, and reconciliation system. Until those external seams are
provisioned, no live Discord canary can run and no provider evidence exists.
