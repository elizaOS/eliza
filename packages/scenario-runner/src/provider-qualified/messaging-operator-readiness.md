# Messaging provider canary operator readiness

The shared messaging operator boundary supports the exact production canaries
for Signal, Telegram, WhatsApp, and X direct messages. It does not contain
provider credentials, call a local plugin as evidence, or claim that any canary
has run. Its output is unsigned source material with
`qualificationClaimed: false`.

Before network access, an operator must provide an offline Ed25519-authorized
manifest, pinned manifest-authority public key, the exact raw provider target
and operation input, both exact negative-probe requests, and a closed operator
plan. The account ID and connection reference are re-bound to the manifest's
connector, and the run nonce is re-bound to the signed run.

Execution requires all six protected-environment capabilities up front:

1. account-scoped credential and capability verification;
2. authenticated ingress to the deployed agent;
3. authenticated provider readback correlated to both signed operation hashes;
4. authenticated replay with an unchanged provider-state snapshot;
5. independent execution of the authorization-denial and provider-rejection
   probes, including unchanged before/after state; and
6. export of the deployed run's canonical trajectory set.

The controller refuses a partial capability set before credential inspection
or ingress. It also rejects unknown fields, a copied preflight object, account
or scope drift, target/input hash substitution, provider non-acceptance,
duplicate replay effects, missing or duplicated probes, the wrong signed error
or HTTP result, state-changing failure probes, and empty trajectory exports.

Provider-specific capability implementations belong in the protected operator
environment. For example, a Signal implementation may use an authenticated
signal-cli service account, Telegram may use the Bot API with an independent
read-only observer identity, WhatsApp must select the signed Cloud API or
Baileys transport target exactly, and X must use the production DM API and an
account-scoped observer. Those implementations must return real provider IDs
and hashes; fixtures from the focused unit tests are never qualification
evidence.

After collection, independent observer and semantic-judge authorities still
must sign their own evidence. The external orchestrator must then verify the
isolated trajectories, assemble and reverify the complete qualification
artifact, clean up the canary target, and only then publish. Until that full
flow runs against all four provider accounts, their production qualification
count remains zero.
