# Staging Resource Ledger Operations

The staging resource ledger makes account, provider, conversation, and runtime
readiness reviewable without publishing the resources themselves. Its
canonical source is
[`.github/certification/staging-resources.yaml`](../../.github/certification/staging-resources.yaml).
The adjacent JSON Schema is the structural contract and the adjacent Markdown
file is generated for reviewers. Canonical coverage, graph, ownership,
freshness, privacy, and readiness invariants are enforced by the checker.

This contract formalizes the requirements discussed by the historical #14459
work. It does not assume that an earlier public fixture authority was committed
to this repository. It preserves the useful custody and lifecycle requirements
while keeping stable locators and personal identifiers outside GitHub.

## Product model encoded by the ledger

The team maintains the shared staging and production messaging ingress. A user
does not create a Discord, Telegram, WhatsApp, X, or iMessage provider bot.
Instead, the user contacts the existing shared ingress, completes central Eliza
onboarding when needed, and the backend routes that provider conversation to a
Personal Shared or Dedicated runtime target.

Every effective DM or group-channel fixture carries the exact
`CENTRAL_ONBOARDING_GATE` capability. Its provider-backed smoke receipt must
cover first contact while unlinked, the central login handoff, and successful
post-link chat in the same provider conversation. `ROUTES_TO` alone proves
neither onboarding nor usefulness.

Every Cloud account and advertised login subject also depends on the Steward
authentication-service row. Provider-specific applications are additional
dependencies, never substitutes for the service that exchanges the resulting
identity into an Eliza session.

A group has exactly one onboarded owner. Other participants are guests and do
not inherit owner authority. Top-level controlled groups therefore carry one
`OWNED_BY` relation to the returning onboarded staging user; a nested Discord
channel depends on its guild, inherits that guild owner, and cannot introduce a
second owner. The
controlled group baseline is
`single-onboarded-owner-guests-no-authority`; changing that behavior is outside
this ledger's scope.

The ledger certifies whether the existing design is coherently provisioned and
testable. It does not authorize a provider grant, bot install, group creation,
membership change, factor enrollment, message send, secret rotation, runtime
deployment, database write, or product-behavior change.

## One resource per record

Each `qar-*` reference represents one independently provisioned or renewable
resource. Owner accounts, applications, bot identities, sender devices,
controlled conversations, organizations, agents, and sandboxes therefore have
separate rows and explicit relations. Effective conversation fixtures expose
both supported `ROUTES_TO` destinations: Personal Shared and the Dedicated
aggregate, which in turn contains its agent and sandbox. This prevents a
configured application from being mistaken for proof that its owner, bot,
group, route, or runtime exists.

The Telegram login-widget row represents only the frontend widget
configuration. It depends on the single Telegram shared-bot identity row; it is
not a second independently renewable bot.

The required 56 `coverage_key` values are compiled into the checker. They cover:

- fresh and returning Cloud users, their mailbox slots, all advertised login
  subjects, and the provider applications or custody objects behind them;
- team-maintained Discord, Telegram, Blooio/iMessage, WhatsApp, and X ingress;
- renewable DM, group, guild/channel, and counterpart fixtures; and
- Personal Shared plus the distinct Dedicated organization, agent, and sandbox
  targets.

`ref` and `coverage_key` are stable public identifiers. Real provider locators
belong only in the private resolver. `binding_generation` changes whenever an
opaque reference is rebound to a replacement resource; evidence from an older
generation cannot certify the replacement. Every receipt used by a `READY`
row must explicitly repeat and match that generation, including mapping,
existence, configuration, permissions, isolation, and lifecycle receipts.
Every one of those receipt sections must declare `binding_generation`: a fully
neutral section declares `null`, while a material finding declares the current
resource generation. Rebinding resets every prior state and receipt to an
unobserved state; changing only the generation number is not sufficient.
`BINDING_REPLACED` records that temporary revalidation gap and is removed once
the replacement generation has complete current evidence. The Telegram widget
reclassification is therefore generation 2 and deliberately carries no
generation-1 bot evidence.

## State and evidence rules

`UNKNOWN` means that no authoritative evidence exists. It never means absent.
`MISSING` and `ABSENT` require evidence from the relevant authority.
`REFERENCE_PRESENT` proves only that an approved names-only configuration
reference was observed. `NOT_RUN` means no action was executed for the current
snapshot.

Every row records mapping, existence, custody, names-only configuration,
permissions, provider/runtime/data isolation, lifecycle operations, three
evidence layers, and a verdict. Provider, runtime, and smoke receipts contain
only an opaque receipt reference, time bounds, source commit, binding
generation, state, and reason code.

The names-only configuration matrix is canonical per public resource ref. Its
authority and variable-name tuples must match the checker exactly; a generic
or syntactically valid replacement name is not configuration parity.

The immutable `snapshot` identifies the code and staging deployment against
which those receipts were observed. `deployment_observation` records the most
recent read-only staging health observation. When its commit differs from the
snapshot, `evidence_alignment` must be `REVALIDATION_REQUIRED`: all prior
`PASS`, failure, and absence findings are historical, the generated view marks
them as such, and no resource may be `READY`. Never replace a receipt's source
SHA merely to make it look current; preserve the old snapshot and perform a
fresh provider/runtime/smoke audit against the new deployment.
Equality between the two public SHA fields is only internal consistency, not
proof of a live deployment. A non-empty `READY` set additionally requires an
independently protected, provider-backed deployment attestation outside the
candidate repository.

`READY` is intentionally strict. It is invalid when a required dimension is
unknown, missing, failed, not run, stale, bound to another generation, or lacks
a dated receipt. A local mock, a repository README, an environment-variable
name, or the existence of source code never satisfies provider-backed proof.
Provider observations may be at most 30 days old, runtime observations seven
days, smoke observations 24 hours, and the other readiness dimensions seven
days. Excessively long validity windows are rejected.

`NOT_REQUIRED` is not a free-form waiver. Only the canonical per-resource paths
compiled into the checker may use it; every other occurrence is rejected.

Opaque receipt and attestation references are not self-authenticating. Any
non-empty `READY` set therefore requires a public, short-lived Ed25519
`ready_authorization`, signed with the operator-held key corresponding to the
repository trust anchor. The checker deterministically binds that signature to
the complete redacted READY records, snapshot, deployment observation,
binding generations, receipt references, signing time, and expiry. With zero
READY rows the authorization must be `null`. Signing is the explicit human
operations trust boundary: it asserts that the private resolver and receipts
were reviewed; the private resolver itself remains outside GitHub.

Public receipt and attestation handles are strictly `rct-` or `att-` plus 32
to 64 lowercase hexadecimal characters. Short numeric challenges and readable
aliases are rejected so the public handle cannot become an OTP, locator, or
description of the private evidence.

The signature is an integrity control, not by itself a repository-governance
boundary. A trusted external repository rule and independent review of the
checker and trust anchor are prerequisites for admitting any `READY` row. Until
that boundary is configured, the committed ledger must retain zero `READY`
rows and `ready_authorization: null`.
The production checker enforces that current condition by rejecting every
non-empty `READY` set; caller-selected or test-only trust anchors are not an
accepted production input. Enabling READY admission must be a separate
protected change that wires the external repository and live-deployment
attestation authorities before any resource verdict changes.

## Private resolver contract

An approved private operations system must resolve each public `qar-*`
reference to the current provider object, primary/backup/recovery roles, and
secret locations. The public row records only whether that mapping is attested,
not where it lives or who it identifies.

The resolver must enforce all of the following outside GitHub:

1. role-based access and an auditable lookup for the exact binding generation;
2. separation between staging and production identities, credentials, data,
   billing, and runtime targets;
3. owner, backup, MFA, recovery, renewal, rotation, revocation, reset, reuse,
   expiry, and cleanup procedures;
4. immutable provider/runtime/smoke receipts with their private evidence; and
5. replacement of personal or temporary accounts with team-managed resources.

No private resolver export or locator is an acceptable pull-request artifact.

## Updating a row

1. Resolve the opaque ref through the approved private system and confirm its
   current `binding_generation`.
2. Perform the least invasive read-only provider and runtime checks available.
   Obtain action-time approval before any OAuth grant, install, group or
   membership change, factor challenge, signature, message, or mutation.
3. Store full evidence privately. Copy only the redacted state, timestamps,
   source commit, reason code, and opaque receipt reference into the ledger.
4. Update `deployment_observation`. If staging moved, retain the historical
   snapshot and use `REVALIDATION_REQUIRED` until every claimed current state
   has been re-observed.
5. Add the owning blocker issue when any required dimension is not ready.
6. Regenerate the schema and review view. Generation uses the current time, so
   expired evidence or authorization is rendered explicitly and causes view
   drift until the historical view is refreshed.
7. Run the checker and focused script tests. An authorized operator signs the
   deterministic READY payload
   only after the private evidence review and only when at least one row is
   genuinely READY.

```bash
node packages/scripts/launch-qa/check-staging-resource-ledger.mjs \
  --write-schema --write-view
bun run test:launch-qa:staging-resources
bun test packages/scripts/launch-qa/check-staging-resource-ledger.test.ts
```

When preparing a genuine READY authorization, leave
`ready_authorization: null` while editing the rows, choose a signing time and
an expiry no more than 24 hours later, and generate the exact public payload:

```bash
node packages/scripts/launch-qa/check-staging-resource-ledger.mjs \
  --print-ready-authorization-payload \
  --signed-at 'YYYY-MM-DDTHH:MM:SSZ' \
  --valid-until 'YYYY-MM-DDTHH:MM:SSZ'
```

The command returns the canonical UTF-8 payload, its SHA-256 digest, and the
metadata to copy into `ready_authorization` only after the same protected
external certification authority and provider-backed live-deployment
attestation required by final `READY` admission have passed. It may omit only
the not-yet-created signature from that admission check. Until both external
authorities are wired, payload preparation intentionally fails closed; it is
not an alternate path to manufacture a `READY` claim. An authorized operator
then signs the payload bytes outside the repository and adds only the canonical
Base64 signature. The private key and private receipts never enter the
worktree.

The PR gate runs the same checker fail-closed: a missing row, broken relation,
schema/view drift, non-approved YAML comment, probable private locator, stale
or generation-mismatched receipt, superseded deployment, invalid readiness
signature, non-ready dependency, or unsupported `READY` verdict blocks the
claim.

## Related authorities

- [Staging deployment authority](../../packages/cloud/infra/STAGING_AUTHORITY.md)
- [Railway service authority](../../packages/cloud/infra/cloud/RAILWAY.md)
- [Discord gateway operations](../../packages/cloud/services/gateway-discord/README.md)
- [Group-chat behavior scenarios](../../packages/test/scenarios/group-chat/behavior/README.md)
- Parent account-readiness epic #25025 and ledger issue #27867

These documents describe code and infrastructure contracts. None of them, on
their own, prove that a live staging account or provider resource is ready.
