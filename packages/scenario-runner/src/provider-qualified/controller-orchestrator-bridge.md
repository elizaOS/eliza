# Raw-controller to orchestrator bridge

This bridge is an operator integration contract, not a provider implementation
and not evidence that a canary ran. It accepts only the repository-owned
scenario/operation/controller mapping and turns a completed, validated raw
controller run into the capability shape consumed by the external canary
orchestrator.

## Trust boundaries

- The deployed controller returns its raw unsigned receipt, the real
  `ScenarioReport`, the filesystem-verified trajectory set, and a cleanup-scope
  digest. The bridge binds all four to the authorized scenario, run, nonce,
  manifest, operation, and failure-probe set.
- The observer signer and semantic-judge signer are remote clients. Their HTTPS
  origins, Ed25519 keys, and declared administrative domains must all differ,
  and their public keys must already be deployment-pinned. The bridge API has
  no private-key parameter.
- The independent observer session begins before ingress. Its completion sees
  the exact canonical raw receipt, runner report, trajectory inventory, and
  their hashes, but may return only the closed unsigned observation fields. The
  bridge supplies every correlation, result, trajectory, and timestamp field
  before sending the completed payload to the remote observer signer. The
  semantic evaluator sees the same source material plus the observer-envelope
  hash and may return only criterion verdicts; the bridge binds manifest-owned
  model identities before remote judge signing. Cross-run envelopes are
  rejected before qualification.
- Cleanup is a remote signed operation bound to the cleanup scope and exact raw
  receipt hash. `takeVerifiedCleanupProof()` is unavailable until verification
  succeeds and can be consumed only once. Operator CLI integration must publish
  that proof atomically beside the qualification artifact; dropping it is a
  publication failure. `verifyProviderCleanupProof()` permits independent
  verification of the adjacent capsule against deployment pins.

The generic qualifier still verifies the observer and judge signatures and all
semantic/provider assertions. The bridge does not translate unsigned receipts
into trusted observations locally and never changes `qualificationClaimed:
false` on controller output.

## Canonical availability

Nine rows have direct raw controller receipt contracts and can enter this
bridge: BlueBubbles/iMessage, Duffel, the three Google Workspace canaries, and
Signal, Telegram, WhatsApp, and X DM through the messaging controller.

The remaining four rows are contractually bridgeable through the shared
manifest-bound deployed-capability contract:

- Discord confirmed send
- Slack confirmed send
- Twilio SMS confirmed send
- Twilio voice confirmed call

For those rows, construction of source material still requires real injected
production seams plus the controller's real provider readback and a real
`ScenarioReport`. The bridge accepts only the closed composite containing the
verified deployed execution and rejects a reconciliation-required cleanup.
This repository supplies the contract, not the deployment implementations or
credentials; none of the four is externally runnable merely because it is
listed as `requires-deployed-composite-adapter`. Readback alone is insufficient.

## Operator integration sequence

1. Select the canonical bridge contract and construct the bridge with pinned
   remote service identities.
2. Pass `bridge.capabilities` into the generic external canary executor, adding
   the CLI's atomic publisher capability.
3. In that publisher, consume `bridge.takeVerifiedCleanupProof()` and stage the
   qualification artifact and cleanup capsule together.
4. Commit the staged directory atomically, then mark the authorization journal
   consumed. A crash before the directory commit remains reconciliation work,
   not permission to retry ingress.

The deterministic tests use generated keys and remote-service doubles to prove
the contract and real qualifier path. They are explicitly not live provider
qualification evidence.
