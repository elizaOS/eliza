# Exact-13 provider canary coordination

`eliza-provider-canary-exact13` is the release-run coordinator for the
repository-owned 13-canary inventory. It consumes 13 directories previously
created by `eliza-provider-operator prepare-run`; it does not create accounts,
credentials, manifests, observer evidence, judge evidence, or live-model
trajectories.

The input order is fixed by `PROVIDER_CANARY_SCENARIO_IDS`. Before any provider
ingress, the coordinator validates every prepared v2 config and canonical
data-only scenario snapshot, verifies the signed authorization and disjoint
public-key pins, hashes the reviewed operator module without importing it, and
requires isolated protected state and output paths. A failure in item 13 means
item 1 is never executed.

The operator ESM is parsed and linked in a credential-free child process but is
not evaluated. It must expose `createExternalProviderCanaryCapabilities` and
may retain only `node:` static imports; build all other reviewed dependencies
into the content-pinned bundle.

```json
{
  "schema": "eliza.exact13-provider-canary-run-config.v1",
  "preparedConfigFiles": [
    "prepared/01-bluebubbles/config.json",
    "prepared/02-discord/config.json",
    "prepared/03-duffel/config.json",
    "prepared/04-gmail/config.json",
    "prepared/05-google-calendar/config.json",
    "prepared/06-google-sheets/config.json",
    "prepared/07-signal/config.json",
    "prepared/08-slack/config.json",
    "prepared/09-telegram/config.json",
    "prepared/10-twilio-sms/config.json",
    "prepared/11-twilio-voice/config.json",
    "prepared/12-whatsapp/config.json",
    "prepared/13-x-dm/config.json"
  ],
  "coordinatorStateDir": "/private/operator/exact13-state",
  "expectedRepositorySha": "0123456789abcdef0123456789abcdef01234567",
  "catalogOutputDir": "/private/operator/exact13-catalog"
}
```

Run the installed command, or the package script during repository development:

```bash
eliza-provider-canary-exact13 /private/operator/exact13.json
bun run --cwd packages/scenario-runner provider-canary:exact13 -- /private/operator/exact13.json
```

## Journal and retry policy

The coordinator writes a plan-hashed journal in a pre-existing, current-user
owned `0700` directory. It durably changes one entry from `pending` to
`running` before invoking the one-canary executor, and changes it to `qualified`
only after independently reverifying the published capsule. A normal pause can
occur only between canaries; resumption reverifies and skips every qualified
entry.

There is no automatic retry path. A thrown/nonzero execution, missing or
invalid capsule, crash after the `running` transition, or journal write failure
is an indeterminate provider effect. The whole set becomes
`reconciliation-required`. An operator must reconcile the provider, deployed
runtime, individual canary journal, and coordinator journal before authoring a
new signed run. Never delete a `running` or `reconciliation-required` record to
make the command proceed.

The invocation lock rejects concurrent coordinators. A lock left by abrupt
process death may be removed only after confirming that no coordinator process
is alive; the journal remains the authority on whether effects are safe to
continue.

## Catalog and evidence-matrix handoff

Only after all 13 publication capsules reverify does the coordinator atomically
publish the canonical catalog. Catalog output is deterministic for the journal's
recorded creation time; a resumed process accepts an existing directory only
when its exact files and bytes match the recomputed result.

An optional `matrixHandoff` block can generate, but does not execute, the closed
offline evidence-matrix producer config:

```json
{
  "matrixHandoff": {
    "publicationOutputDir": "/repo/reports/provider-qualification/operator-run-001",
    "outputDir": "/private/operator/matrix-handoff"
  }
}
```

The generated v2 producer config contains the 13 verified `publication.json`
paths in canonical order. No config-controlled TypeScript scenario is loaded
by the coordinator. Run `matrix-producer.json` separately through the
bundle-first matrix command. Its offline reverifier and canonical producer
remain responsible for publishing evidence beneath the repository reports
root.

Completion means 13 cryptographically reverified, publishable provider
qualification capsules for one repository and deployment revision. It does not
mean exactly-once delivery, and the coordinator never claims evidence for a run
that did not produce those capsules.
