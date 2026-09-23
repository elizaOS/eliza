# Confidential service plugin assessment

Assessment date: September 23, 2026. Parent: [#32315](https://github.com/elizaOS/eliza/issues/32315), control program: [#22869](https://github.com/elizaOS/eliza/issues/22869).

## Deployment scope and implementation priority

The product supports a local Android/Linux agent and an optional cloud agent.
The inventory below evaluates the specific confidential-cloud topology named in
#32315; it is not a universal prerequisite list for running elizaOS. Its pinned
classifications remain historical evidence, not current release approvals.

Use one runtime, canonical identity/roles, authorization contracts, scheduler and
agent-owned durable database across both deployments. Start with one active,
authoritative instance per agent. Device-to-cloud migration must preserve data,
keys, permissions, revocations and scheduled-work ownership before activating the
destination. Concurrent active replicas and bidirectional synchronization are
separate capabilities, not prerequisites for this product scope.

| Layer | Required common capability | Deployment-specific implementation |
| --- | --- | --- |
| Identity and pairing | Authenticated people, owner-authorized device enrollment, revocable sessions and existing roles | Device credential protection and transport establishment |
| Data authority | Scoped grants enforced before retrieval enters model context and before actions disclose or mutate data | Same authority contract on device and cloud; no implicit full access from pairing |
| Persistence and recovery | Durable transactions, encrypted state, controlled keys, export/deletion, backup and restore that cannot resurrect revoked authority | Device keystore and storage protection versus cloud key/storage services |
| Plugin effects | Explicit capability admission for storage, credentials, networking and execution, enforced at actual dispatch | OS isolation and deployment-approved endpoints |
| Audit and operation | Durable security events, update integrity, incident evidence and recovery procedures | Local recording and profile-specific independent archive; device supervision versus cloud operations |
| Inference | Complete authorized context, streaming output and policy-checked model/audio/embedding dispatch | On-device models or explicitly admitted remote endpoints in either deployment |

The current native SQLite adapter is explicitly Node 24.15.0-only. It does not
establish Android/Bun support: pinned Bun 1.3.14 cannot import `node:sqlite`, and
its `node:v8` serialized records failed Node deserialization in a generated-data
probe. [#32386](https://github.com/elizaOS/eliza/issues/32386) tracks compatible
storage drivers and lossless state portability, including existing-database
migration. These macOS runtime probes are not Android hardware evidence. Keep the
current Node deployment contract until the additional runtime is qualified.

Local hosting removes the need for our per-agent hosted compute and database.
It does not remove remote-inference, relay, optional backup or support costs.
A local runtime using a remote model still discloses the dispatched data to that
processor. Device availability needs measured restart, power-loss, update,
background-execution and recovery behavior; an always-on intention is not proof.

Reuse the canonical role vocabulary and identity/relationship stores. Role
presets for medical, financial or government products can compose scoped grants
for subjects, resources and actions without introducing separate identity or
permission engines. Administrative authority must not implicitly grant every
person's private data. Shared model-context caches and histories must obey the
same access boundary as fresh retrieval.

### Conversational performance contract

Security decisions on the conversational path should be deterministic and local.
Use indexed permission reads and versioned caches with tested invalidation;
perform hardware/build admission at enrollment, startup and renewal where the
profile requires it. Verify current session and grant authority at each protected
boundary, including long-running actions after revocation. Offline behavior must
state which authority remains valid and for how long; disconnected devices cannot
promise immediate knowledge of a remote revocation.

Do not add an LLM authorization step or mandatory cloud policy round trip to each
utterance. Record required audit events durably before acknowledging protected
effects; remote export may run asynchronously only when the selected profile
allows it, with explicit backlog/failure handling. Benchmark added authorization
time, time to first token, time to first audio and sustained streaming on actual
target devices and cloud configurations. Zero latency overhead is not established
by this assessment. Do not trade away complete model context to meet latency goals.

### Delivery order and deferred capabilities

Prioritize pairing, scoped data access, portable durable storage, controlled
external dispatch, encryption/key handling, audit, rights, recovery and signed
updates. Qualify a bounded supported plugin configuration on an actual device and
cloud target; disabled plugins need not all be ported before that configuration
can ship.

Provider/caregiver workflows, custody agreements, household negotiations, shared
training and simultaneous active replicas are deferred product capabilities.
Their existing implementation work is preserved, but they are not prerequisites
for the reusable security foundation. TDX/Nitro qualification, independent cloud
key release and multi-CVM recovery remain requirements of the confidential-cloud
profile wherever selected, rather than mandatory implementation details of every
local agent. These deferrals do not count as acceptance of the original epic's
corresponding criteria or establish a regulated deployment's release readiness.

Interpret plugin assessment along three independent dimensions:

1. Runtime compatibility: platform, storage backend and available capabilities.
2. Security behavior: data accessed, recipients, credentials and effect isolation.
3. Deployment approval: applicable purpose, contracts, operational controls and
   actual evidence for the enabled feature.

An endpoint-dependent Android capability may be appropriate on its owning device.
A PostgreSQL dependency is a SQLite portability blocker, not by itself a legal
compliance finding. Remote providers/connectors share dispatch controls but still
need approval for their actual destination and feature. Shell, browser, MCP and
untrusted code require isolation that prevents bypass of common controls.

## Confidential-cloud inventory decision

The default application plugin set cannot currently be used unchanged for the selected one-agent, one-SQLite-database Linux confidential VM service. This assessment inventories **109 first-party workspace packages** under `plugins/`, including native libraries that are not runtime `Plugin` objects. It replaces the historical 108-package count for this revision only.

**No package is approved for sensitive production use by this document.** Service eligibility is `unknown` for every entry because exact deployment, feature, region, contract and operational approval evidence was not supplied. Engineering readiness below is a separate dimension. `blocked` means a known mismatch with this selected topology, not a claim that the package can never be used lawfully in another service. This report does not enforce runtime policy.

The [machine-readable assessment](confidential-plugin-assessment.json) records every package name, version, source revision, engineering classification, remediation and source references. Sources are pinned to `b71c7c3577b0ab842089dedbf527058a1fe167b6`; same-version later code requires reassessment. Package manifests define inventory membership. Descriptors and source determine runtime constraints; README statements are supporting context and can be stale. This is static engineering triage, not an exhaustive source audit or observed network/storage trace.

## Confirmed incompatibilities and substantial work

| Surface | Finding and required outcome |
| --- | --- |
| Built-in host plugin | The agent host's [`eliza` plugin](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/packages/agent/src/runtime/eliza-plugin.ts) registers canonical graph and pendant PostgreSQL schemas without SQLite qualification. Its [pendant repository factory](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/packages/agent/src/services/pendant-session/repository.ts) always selects SQL. This host-owned plugin is outside the 109-package inventory but also needs a native port and boot proof; the graph port alone cannot qualify it. Preserve capture leases, revisions, ordered segments and insight references in the existing agent database. |
| SQLite domain activation | `blocker`, `browser`, `calendar`, `discord`, `finances`, `goals`, `inbox`, `personal-assistant`, `relationships`, `reminders`, `todos`, `workflow` declare SQL dependencies or PostgreSQL schemas without an explicit SQLite port. The existing host rejects them with `SQLITE_PLUGIN_INCOMPATIBLE`. Port canonical stores and preserve ownership, atomic claims, grants, idempotency and migrations. Merely adding `databaseBackends: ["sqlite"]` would misrepresent support. |
| Storage alternatives | `sql` provides PostgreSQL/PGlite, outside the selected SQLite topology. `inmemorydb` cannot provide durable production state. `sqlite` is a foundation, not filesystem encryption, a remote audit archive or recovery fencing. |
| Scheduling | `scheduling` already declares and implements SQLite support. Its older SQLite-adapter README still describes scheduling as unported; the current scheduling implementation is authoritative. The personal-assistant/health domains and restore-authority proof remain outstanding. |
| Model providers | `openai`, `anthropic`, `google-genai`, `embeddings`, `fish-audio`, `zai` need exact service/model/feature approval and complete admitted dispatch. Independent embedding, STT, TTS, image and research calls count. No conclusion about a vendor's BAA eligibility follows from the plugin name. |
| Subscription inference | `anthropic-proxy`, `codex-cli`, `cli-inference` must remain outside this sensitive profile pending exact product/contract approval and confidential transport qualification. Subscription login or a consumer CLI is not attestation. |
| Local inference | `local-inference`, `zerollama`, and mobile inference bridges need actual model/runtime and hardware qualification. CPU attestation does not prove GPU protection or a phone's inference boundary. |
| General execution | Browser/computer use, MCP, coding tools, PTYs, workflow execution, skills and dynamic plugin management require process/network isolation with scoped credentials and pinned code. Enforce admission on actual dispatch, including direct networking and child processes. |
| Native endpoints | Android SMS/phone/contacts/Wi-Fi, Apple Calendar/Reminders/alarms, activity tracking, camera, location, screen capture and voice remain endpoint functions. Retain a separately authorized endpoint boundary; do not describe them as running privately inside a Linux CVM. Some libraries have web/server branches, which need separate qualification. |
| External recipients | Messaging, workplace, search/maps, delivery, meeting, wallet and cloud connectors disclose to their actual recipients/services. Limit the released fields by purpose and authority, obtain exact approvals, and prove receipts, retention and rights propagation. A vendor-wide report cannot approve all connector modes. |
| Health/graph integration | `health` relies on host-provided storage/actions/authority, including personal-assistant. A healthy plugin load does not prove those capabilities exist in SQLite. Canonical graph and household ports are prerequisites for family/concierge access. |

The activation finding is grounded in [database selection](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/packages/agent/src/runtime/database-selection.ts) and the per-package descriptors below. Scheduling's implemented exception is in [its descriptor](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-scheduling/src/plugin.ts) and [SQLite storage contract](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-scheduling/README.md). A descriptor-level rejection is not proof that other plugins are compatible: indirect storage and external processing still need qualification.

## Admission and evidence contract

For each enabled use, the accountable owner must approve an immutable package/build identity, capability, canonical agent/subject/purpose, processor, actual endpoint/model/feature, region/transfers, retention/training terms, contract reference, permitted recipient/fields, attestation policy, expiry and revocation source. Keep private contracts and credentials out of this public record. Unknown, expired, revoked and changed entries must deny sensitive dispatch. Conditional approval cannot authorize dispatch until its conditions are verified.

Evidence must exercise the actual installed build: zero prohibited payload/credential bytes; complete legitimate model context; endpoint mutation and fallback denial; subprocess/network containment; SQLite reopen/rollback/concurrency; cross-agent/case denial; revoked active access; export/deletion propagation; restored consent/deletion/key authority; and independent durable audit reconciliation. Static inventory is an input to W0/W1, not acceptance of either work package or S01–S20.

Coordination update, September 23, 2026: [#32256](https://github.com/elizaOS/eliza/pull/32256) merged measured process/model admission after the inventory snapshot. [#32281](https://github.com/elizaOS/eliza/pull/32281) (SQLite authentication) has also merged; [#32283](https://github.com/elizaOS/eliza/issues/32283) (measured API/scoped identity) remains open. The merged foundation is not production qualification or approval of every plugin dispatch path. The catalog retains its pinned source revision; reassess changed packages against their actual deployed build. [#32342](https://github.com/elizaOS/eliza/pull/32342) merged the canonical SQLite graph port tracked by [#32322](https://github.com/elizaOS/eliza/issues/32322). This improves engineering compatibility after the snapshot; the historical catalog below is not rewritten as deployment approval.

## Complete catalog

The links identify pinned package manifests; the JSON includes available entry points and README paths. Classification is conservative static triage. Every row's service eligibility remains **unknown**.

| Directory | Package version | Engineering readiness | Work category |
| --- | --- | --- | --- |
| [plugin-agent-orchestrator](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-agent-orchestrator/package.json) | `@elizaos/plugin-agent-orchestrator@2.0.3-beta.7` | significant-work | execution |
| [plugin-agent-skills](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-agent-skills/package.json) | `@elizaos/plugin-agent-skills@2.0.3-beta.7` | significant-work | execution |
| [plugin-anthropic](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-anthropic/package.json) | `@elizaos/plugin-anthropic@2.0.3-beta.7` | significant-work | remote-model |
| [plugin-anthropic-proxy](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-anthropic-proxy/package.json) | `@elizaos/plugin-anthropic-proxy@2.0.3-beta.7` | blocked-pending-approval | subscription-model |
| [plugin-app-control](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-app-control/package.json) | `@elizaos/plugin-app-control@2.0.3-beta.7` | significant-work | execution |
| [plugin-app-manager](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-app-manager/package.json) | `@elizaos/plugin-app-manager@2.0.3-beta.7` | significant-work | execution |
| [plugin-assistant](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-assistant/package.json) | `@elizaos/plugin-assistant@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-blocker](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-blocker/package.json) | `@elizaos/plugin-blocker@2.0.3-beta.7` | blocked | sql-port |
| [plugin-browser](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-browser/package.json) | `@elizaos/plugin-browser@2.0.3-beta.7` | blocked | sql-port |
| [plugin-calendar](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-calendar/package.json) | `@elizaos/plugin-calendar@2.0.3-beta.7` | blocked | sql-port |
| [plugin-capacitor-bridge](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-capacitor-bridge/package.json) | `@elizaos/plugin-capacitor-bridge@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-cli-inference](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-cli-inference/package.json) | `@elizaos/plugin-cli-inference@2.0.3-beta.7` | blocked-pending-approval | subscription-model |
| [plugin-cloud-apps](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-cloud-apps/package.json) | `@elizaos/plugin-cloud-apps@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-codex-cli](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-codex-cli/package.json) | `@elizaos/plugin-codex-cli@2.0.3-beta.7` | blocked-pending-approval | subscription-model |
| [plugin-coding-tools](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-coding-tools/package.json) | `@elizaos/plugin-coding-tools@2.0.3-beta.7` | significant-work | execution |
| [plugin-commands](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-commands/package.json) | `@elizaos/plugin-commands@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-companion](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-companion/package.json) | `@elizaos/plugin-companion@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-computeruse](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-computeruse/package.json) | `@elizaos/plugin-computeruse@2.0.3-beta.7` | significant-work | execution |
| [plugin-contacts](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-contacts/package.json) | `@elizaos/plugin-contacts@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-discord](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-discord/package.json) | `@elizaos/plugin-discord@2.0.3-beta.7` | blocked | sql-port |
| [plugin-documents](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-documents/package.json) | `@elizaos/plugin-documents@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-doordash](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-doordash/package.json) | `@elizaos/plugin-doordash@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-dropbox](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-dropbox/package.json) | `@elizaos/plugin-dropbox@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-elizacloud](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-elizacloud/package.json) | `@elizaos/plugin-elizacloud@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-embeddings](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-embeddings/package.json) | `@elizaos/plugin-embeddings@2.0.3-beta.7` | significant-work | remote-model |
| [plugin-finances](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-finances/package.json) | `@elizaos/plugin-finances@2.0.3-beta.7` | blocked | sql-port |
| [plugin-fish-audio](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-fish-audio/package.json) | `@elizaos/plugin-fish-audio@0.1.0` | significant-work | remote-model |
| [plugin-form](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-form/package.json) | `@elizaos/plugin-form@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-github](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-github/package.json) | `@elizaos/plugin-github@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-goals](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-goals/package.json) | `@elizaos/plugin-goals@2.0.3-beta.7` | blocked | sql-port |
| [plugin-google-genai](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-google-genai/package.json) | `@elizaos/plugin-google-genai@2.0.3-beta.7` | significant-work | remote-model |
| [plugin-google-workspace](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-google-workspace/package.json) | `@elizaos/plugin-google-workspace@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-health](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-health/package.json) | `@elizaos/plugin-health@2.0.3-beta.7` | significant-work | sensitive-domain |
| [plugin-imessage](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-imessage/package.json) | `@elizaos/plugin-imessage@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-inbox](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-inbox/package.json) | `@elizaos/plugin-inbox@2.0.3-beta.7` | blocked | sql-port |
| [plugin-inmemorydb](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-inmemorydb/package.json) | `@elizaos/plugin-inmemorydb@2.0.3-beta.7` | blocked | storage |
| [plugin-instagram](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-instagram/package.json) | `@elizaos/plugin-instagram@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-linear](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-linear/package.json) | `@elizaos/plugin-linear@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-local-inference](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-local-inference/package.json) | `@elizaos/plugin-local-inference@2.0.3-beta.7` | significant-work | local-model |
| [plugin-maps](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-maps/package.json) | `@elizaos/plugin-maps@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-matrix](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-matrix/package.json) | `@elizaos/plugin-matrix@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-mcp](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-mcp/package.json) | `@elizaos/plugin-mcp@2.0.3-beta.7` | significant-work | execution |
| [plugin-meetings](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-meetings/package.json) | `@elizaos/plugin-meetings@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-messages](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-messages/package.json) | `@elizaos/plugin-messages@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-native-activity-tracker](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-activity-tracker/package.json) | `@elizaos/native-activity-tracker@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-agent](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-agent/package.json) | `@elizaos/capacitor-agent@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-appblocker](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-appblocker/package.json) | `@elizaos/capacitor-appblocker@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-browser-surface](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-browser-surface/package.json) | `@elizaos/capacitor-browser-surface@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-bun-runtime](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-bun-runtime/package.json) | `@elizaos/capacitor-bun-runtime@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-calendar](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-calendar/package.json) | `@elizaos/capacitor-calendar@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-camera](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-camera/package.json) | `@elizaos/capacitor-camera@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-canvas](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-canvas/package.json) | `@elizaos/capacitor-canvas@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-contacts](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-contacts/package.json) | `@elizaos/capacitor-contacts@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-desktop](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-desktop/package.json) | `@elizaos/capacitor-desktop@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-eliza-tasks](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-eliza-tasks/package.json) | `@elizaos/capacitor-eliza-tasks@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-filesystem](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-filesystem/package.json) | `@elizaos/plugin-native-filesystem@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-gateway](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-gateway/package.json) | `@elizaos/capacitor-gateway@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-inference](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-inference/package.json) | `@elizaos/plugin-native-inference@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-llama](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-llama/package.json) | `@elizaos/capacitor-llama@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-location](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-location/package.json) | `@elizaos/capacitor-location@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-macosalarm](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-macosalarm/package.json) | `@elizaos/macosalarm@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-messages](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-messages/package.json) | `@elizaos/capacitor-messages@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-mlkit-text](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-mlkit-text/package.json) | `@elizaos/capacitor-mlkit-text@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-mobile-agent-bridge](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-mobile-agent-bridge/package.json) | `@elizaos/capacitor-mobile-agent-bridge@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-mobile-signals](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-mobile-signals/package.json) | `@elizaos/capacitor-mobile-signals@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-network-policy](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-network-policy/package.json) | `@elizaos/capacitor-network-policy@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-phone](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-phone/package.json) | `@elizaos/capacitor-phone@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-reminders](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-reminders/package.json) | `@elizaos/macosreminders@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-screencapture](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-screencapture/package.json) | `@elizaos/capacitor-screencapture@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-secure-store](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-secure-store/package.json) | `@elizaos/capacitor-secure-store@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-settings](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-settings/package.json) | `@elizaos/plugin-native-settings@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-shared-types](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-shared-types/package.json) | `@elizaos/native-plugin-shared-types@2.0.0-beta.2` | build-only | types |
| [plugin-native-swabble](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-swabble/package.json) | `@elizaos/capacitor-swabble@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-system](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-system/package.json) | `@elizaos/capacitor-system@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-talkmode](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-talkmode/package.json) | `@elizaos/capacitor-talkmode@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-websiteblocker](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-websiteblocker/package.json) | `@elizaos/capacitor-websiteblocker@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-native-wifi](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-native-wifi/package.json) | `@elizaos/capacitor-wifi@2.0.3-beta.7` | endpoint-dependent | native |
| [plugin-notes](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-notes/package.json) | `@elizaos/plugin-notes@2.0.0` | needs-integration-proof | sensitive-domain |
| [plugin-notion](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-notion/package.json) | `@elizaos/plugin-notion@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-omarchy](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-omarchy/package.json) | `@elizaos/plugin-omarchy@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-openai](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-openai/package.json) | `@elizaos/plugin-openai@2.0.3-beta.7` | significant-work | remote-model |
| [plugin-pdf](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-pdf/package.json) | `@elizaos/plugin-pdf@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-personal-assistant](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-personal-assistant/package.json) | `@elizaos/plugin-personal-assistant@2.0.3-beta.7` | blocked | sql-port |
| [plugin-phone](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-phone/package.json) | `@elizaos/plugin-phone@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-pty](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-pty/package.json) | `@elizaos/plugin-pty@1.0.0` | significant-work | execution |
| [plugin-registry](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-registry/package.json) | `@elizaos/plugin-registry@2.0.3-beta.7` | significant-work | execution |
| [plugin-relationships](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-relationships/package.json) | `@elizaos/plugin-relationships@2.0.3-beta.7` | blocked | sql-port |
| [plugin-reminders](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-reminders/package.json) | `@elizaos/plugin-reminders@2.0.3-beta.7` | blocked | sql-port |
| [plugin-scheduling](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-scheduling/package.json) | `@elizaos/plugin-scheduling@2.0.3-beta.7` | partial-foundation | scheduler |
| [plugin-slack](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-slack/package.json) | `@elizaos/plugin-slack@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-spotify](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-spotify/package.json) | `@elizaos/plugin-spotify@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-sql](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-sql/package.json) | `@elizaos/plugin-sql@2.0.3-beta.7` | blocked | storage |
| [plugin-sqlite](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-sqlite/package.json) | `@elizaos/plugin-sqlite@2.0.3-beta.7` | partial-foundation | storage |
| [plugin-task-coordinator](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-task-coordinator/package.json) | `@elizaos/plugin-task-coordinator@2.0.3-beta.7` | significant-work | execution |
| [plugin-taskmarket](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-taskmarket/package.json) | `@elizaos/plugin-taskmarket@0.1.0` | significant-work | external-connector |
| [plugin-telegram](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-telegram/package.json) | `@elizaos/plugin-telegram@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-todos](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-todos/package.json) | `@elizaos/plugin-todos@2.0.3-beta.7` | blocked | sql-port |
| [plugin-trajectory-logger](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-trajectory-logger/package.json) | `@elizaos/plugin-trajectory-logger@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-video](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-video/package.json) | `@elizaos/plugin-video@2.0.3-beta.7` | needs-integration-proof | sensitive-domain |
| [plugin-vision](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-vision/package.json) | `@elizaos/plugin-vision@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-wallet](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-wallet/package.json) | `@elizaos/plugin-wallet@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-web-search](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-web-search/package.json) | `@elizaos/plugin-web-search@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-wechat](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-wechat/package.json) | `@elizaos/plugin-wechat@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-whatsapp](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-whatsapp/package.json) | `@elizaos/plugin-whatsapp@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-wifi](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-wifi/package.json) | `@elizaos/plugin-wifi@2.0.3-beta.7` | endpoint-dependent | device |
| [plugin-workflow](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-workflow/package.json) | `@elizaos/plugin-workflow@2.0.3-beta.7` | blocked | sql-port |
| [plugin-x](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-x/package.json) | `@elizaos/plugin-x@2.0.3-beta.7` | significant-work | external-connector |
| [plugin-zai](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-zai/package.json) | `@elizaos/plugin-zai@2.0.3-beta.7` | significant-work | remote-model |
| [plugin-zerollama](https://github.com/elizaOS/eliza/blob/b71c7c3577b0ab842089dedbf527058a1fe167b6/plugins/plugin-zerollama/package.json) | `@elizaos/plugin-zerollama@2.0.3-beta.7` | significant-work | local-model |

## Remaining program gates

This assessment completes neither the epic nor compliance. Preserve all W0–W13, A1–A6 and S01–S20 acceptance criteria. For the local/cloud foundation, prioritize canonical SQLite storage, pairing and scoped identity; then prove scoped effects, media, audit, rights and recovery in each supported deployment. Specialized household/domain acceptance remains deferred as described above. Evaluate no-training, tenant training and shared training independently, with promotion disabled until each program's release gates pass.

The following require accountable external owners and real evidence: exact TDX and Nitro targets; approved inference endpoint and GPU topology; independent release/key authority; encrypted multi-CVM and second-site recovery; legal scope, purposes and applicable contracts; workforce IdP/MDM and staffed escalation; independent audit archive; retention/holds and RTO/RPO decisions; privacy/security assessment; and the SOC 2 examination and observation period. Unavailable evidence remains an open release gate.

HIPAA applicability and safeguards include administrative and physical controls and business-associate arrangements, not encryption alone ([HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html)). GDPR assessment must address processing principles, lawful bases, special-category conditions, rights, processors, security and international transfers ([Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj)). SOC 2 is an examination of a defined service organization's controls, not a certificate issued by this repository ([AICPA SOC services](https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2)).
