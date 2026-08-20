# @elizaos/scenario-runner

End-to-end scenario runner for elizaOS agents. Loads `.scenario.ts` files, executes them against a real `AgentRuntime`, and reports pass/fail with per-turn assertion detail.

## What it is

The scenario runner is the integration-testing harness for elizaOS plugins and agent behaviour. Unlike unit tests that mock the runtime, it boots a real `AgentRuntime` backed by PGLite (an in-process Postgres) and drives it through scripted conversation turns. It is used by `packages/test/scenarios/` and by individual plugin test suites.

## Quick start

```bash
# run a single scenario directory with a live LLM provider key
OPENAI_API_KEY=sk-... eliza-scenarios run ./test/scenarios --scenario my-scenario-id

# deterministic mode — no model key required, uses the fixture-backed model provider
SCENARIO_USE_DETERMINISTIC_MODEL=1 eliza-scenarios run ./test/scenarios

# list discovered scenarios without running them
eliza-scenarios list ./test/scenarios
```

## Writing a scenario

Create a `<name>.scenario.ts` file and export a `ScenarioDefinition`:

```ts
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

export default {
  id: "greet-happy-path",
  title: "Greeting: happy path",
  domain: "greet",
  tags: ["deterministic"],
  turns: [
    {
      name: "user says hello",
      kind: "message",
      text: "Hello",
      assertResponse(text) {
        if (!text.toLowerCase().includes("hello")) {
          return "expected a greeting in the response";
        }
      },
    },
  ],
  finalChecks: [
    { type: "actionCalled", name: "REPLY called", actionName: "REPLY", minCount: 1 },
  ],
} satisfies ScenarioDefinition;
```

### Turn kinds

| Kind | What it does |
|---|---|
| `message` | Sends text through `runtime.messageService.handleMessage` (full conversational path) |
| `action` | Calls a named action's `validate` + `handler` directly (bypasses LLM routing) |
| `api` | Makes an HTTP request to the agent's registered routes via a loopback server |
| `tick` | Invokes the lifeops scheduler at a logical clock time |

### Assertions

**Per-turn:**
- `assertResponse(text | status, body)` — return a non-empty string to fail
- `assertTurn(execution)` — inspect the full `ScenarioTurnExecution`
- `responseIncludesAny: string[]` — response must contain at least one
- `forbiddenActions: string[]` — scenario fails if any of these actions fire
- `responseJudge: { rubric, minimumScore }` — LLM-as-judge scoring

**Final checks** (after all turns, in `finalChecks` array):
`actionCalled`, `selectedAction`, `judgeRubric`, `connectorDispatchOccurred`,
`noSideEffects`, `memoryWriteOccurred`, `approvalRequestExists`,
`browserTaskCompleted`, `messageDelivered`, and more — see `schema/index.js`
for the full list.

Use turn-scoped binding checks for safety and ordering. Action names, action
success values, and response prose do not prove that an effect happened:

```ts
finalChecks: [
  {
    type: "noSideEffects",
    name: "proposal is read-only",
    turn: "proposal",
    allowApprovalRequests: true,
  },
  {
    type: "connectorDispatchOccurred",
    name: "one confirmed dispatch",
    channel: "sms",
    turn: "confirm",
    minCount: 1,
    maxCount: 1,
    delivered: true,
  },
]
```

`noSideEffects` inspects authoritative connector dispatches, durable state
transitions, artifacts, and approval creation. It intentionally ignores
action-result inference. Set `allowApprovalRequests` only when creating a
pending approval is the safe continuation being tested.

## CLI flags

```
eliza-scenarios run  <dir>
  --report <path>          Write JSON aggregate report
  --report-dir <dir>       Write report bundle to directory
  --run-dir <dir>          Store per-turn trajectories here
  --export-native <path>   Export trajectory JSONL for training corpus
  --runId <id>             Override the auto-generated run UUID
  --scenario id1,id2       Filter to specific scenario IDs
  [fileGlob ...]           Filter by file glob pattern
```

## Provider-qualified release evidence

The ordinary executor is an in-process diagnostic harness. It can exercise a
real model and real plugin code, but it creates scenario identities and invokes
the runtime directly, so it is never a trustworthy provider-evidence boundary.
Declaring `executionProfile: "provider-qualified"` does not relabel that path:
the executor fails closed, mixed-profile or multi-scenario runs are rejected,
and the CLI returns nonzero and withholds native export unless exactly one
report carries independently verified, publishable qualification.

An out-of-process controller can use the public primitives under
`src/provider-qualified/` to:

1. build a closed, content-hashed run manifest bound to deployment, principal,
   room, every connector account/capability, and the exact required
   observations;
2. drive authenticated production ingress while independent observers collect
   provider, durable-database, and scheduler evidence;
3. recompute exact trajectory and stage hashes from a fresh isolated run
   directory; and
4. derive qualification from a pinned Ed25519 observer signature, exact
   observation/result multisets, independent semantic verdicts, provider
   acceptance, and required readback/idempotency.

The qualifier always records `exactlyOnce: false`; provider idempotency and
readback reduce ambiguity but do not prove end-to-end exactly-once delivery.
Action results, model prose, loopback fixtures, local PGlite, and unsigned
same-process observations cannot satisfy these contracts.

The provider-canary catalog under `packages/test/scenarios/provider-qualified/`
covers Gmail, Google Calendar, Google Drive/Sheets, Discord, Slack, Telegram,
WhatsApp, X DM, Twilio SMS and voice, BlueBubbles/iMessage, Signal, and Duffel
travel. Before authenticated ingress, an operator controller must pass the
exact canary definition and its externally authored manifest through
`preflightProviderCanary`. Missing manifests are a hard refusal, and a manifest
for another scenario, account, connector, or observation contract is rejected.
This preflight only validates the trust binding; it does not execute the canary
or manufacture qualification evidence. Non-qualifiable generic surfaces are
source-documented in `_provider-canary-exclusions.json`.

### Operator manifest authorization

Before provisioning a target or sending authenticated ingress, authorize the
canonical manifest offline and validate it against deployment-owned public-key
pins:

```ts
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  preflightAuthorizedProviderCanaryExecution,
} from "@elizaos/scenario-runner";

const targetBinding = createProviderCanaryTargetBinding({
  kind: operationKind,
  providerTarget,
  operationInput,
});
const authorization = authorizeProviderCanary({
  scenario,
  bindings: { ...bindings, target: { ...bindings.target, operation: targetBinding } },
  manifestAuthorityPrivateKey, // an Ed25519 private KeyObject
});

preflightAuthorizedProviderCanaryExecution({
  scenario,
  authorization,
  pinnedManifestAuthorityPublicKeysPem,
  operationKind,
  providerTarget,
  operationInput,
});
```

The returned authorization bundle contains only the manifest, key ID, digest,
and signature; it never serializes the private key. Generate and retain the key
outside the repository (prefer an offline signer or managed key store), publish
only the SPKI public-key pin, and keep provider credentials out of the manifest.
The provider target and complete non-credential operation input remain in
operator-controlled JSON; their canonical hashes are signed into the manifest
and rechecked before execution.
The independent observer must repeat that exact hash-only operation binding and
the manifest-authorized capability grant hashes in each signed
connector-binding record. Qualification rejects evidence for a different
recipient, resource, operation input, or authorization grant even when the
observer signature and connector account are otherwise valid.
Every operator manifest must also bind two negative probes for the same
provider operation: one authorization denial and one provider rejection. Each
probe fixes the connector/account, canonical request-payload hash, expected
status and error-code hash, authorization-grant hash, and provider-state scope.
After the positive scenario ends, the independent observer must execute and
sign both probes, including exact response hashes and equal before/after
provider snapshot hashes. Missing, substituted, stale, unexpectedly successful,
or state-changing probes make the run unpublishable. Authorization denial must
record no provider request ID; provider rejection must record a hashed provider
request ID, proving that the rejection reached the provider boundary.
This preflight proves operator authorization of the exact scenario and binding
contract only. It does not contact a provider, create observations, run the
independent semantic judge, or make evidence publishable.

### Offline qualification verification

After an external controller completes one isolated provider run, verify the
retained artifacts with trusted code and deployment-owned public-key pins:

```bash
bun run --cwd packages/scenario-runner provider-qualification -- \
  verify /absolute/path/to/verify-config.json
```

```json
{
  "schema": "eliza.provider-qualification-verify-config.v2",
  "scenarioFile": "provider.gmail.confirmed-send.scenario.ts",
  "authorizationFile": "authorization.json",
  "operationKind": "gmail.email-send",
  "providerTargetFile": "provider-target.json",
  "operationInputFile": "operation-input.json",
  "failureProbesFile": "failure-probes.json",
  "manifestAuthorityPublicKeyFiles": ["keys/manifest-authority.pub.pem"],
  "runDir": "run",
  "observerEvidenceFile": "observer-evidence.json",
  "observerPublicKeyFiles": ["keys/provider-observer.pub.pem"],
  "semanticEvidenceFile": "semantic-evidence.json",
  "semanticJudgePublicKeyFiles": ["keys/semantic-judge.pub.pem"],
  "runnerReportFile": "runner-report.json",
  "outputDir": "/private/operator/provider-qualification/operator-run-001/gmail"
}
```

The closed `eliza.provider-qualification-verify-config.v2` JSON object names
the authored scenario, operator authorization, isolated run directory, signed
observer and semantic-judge envelopes, runner report, three independent sets
of public-key files, and a new output directory. Paths are resolved relative to
the config file. Optional controls are `expectedTrajectoryRelativePaths`,
`maxArtifactAgeMs`, `maxSignatureAgeMs`, and `maxClockSkewMs`; unknown fields
fail validation.

`failure-probes.json` is a private operator input containing the exact raw
preimages for the signed negative-probe commitments. It is a closed array with
one `authorization-denied` probe and one `provider-rejected` probe, using the
manifest probe IDs and non-secret request, expected-error, state-scope, and
authorization-grant descriptors. The verifier recomputes every domain-separated
hash before ingress. Never place bearer tokens, OAuth refresh tokens, private
keys, or other provider credentials in this file; keep those in the operator's
secret manager. Do not publish this private input as provider evidence.

The verifier recomputes trajectory and stage hashes from disk, validates the
operator signature, derives qualification from the signed observer and judge
evidence, and writes a mode-0600 v4 `qualification.json` capsule plus
`qualification.md` into a newly created mode-0700 directory. Exit status is
zero only for a publishable decision with independently verified provider
acceptance, provider readback, and idempotent replay. The v4 capsule contains
the canonical scenario and manifest, public Ed25519 pins, signed hash-only
observer and judge envelopes, a path-free verified trajectory inventory, the
hash-only runner-result projection, and the recomputed decision. It contains no
private target preimages, credentials, private keys, raw trajectory bodies,
runner transcript, or local run-directory path. This command does not execute
ingress, collect evidence, access provider credentials, or post to GitHub.

Private verifier inputs remain operator material. For repository evidence
review, use the coordinated matrix producer described in
`scripts/evidence-review/README.md`; it stages those inputs outside the
repository and publishes only the validated v4 public capsules, canonical
catalog, and Markdown beneath `reports/provider-qualification/<operator-run-id>/`
after the exact 13-canary catalog passes. A verifier output created before the
matrix snapshot is baseline-excluded.

Once every canary has an independently verified artifact, create the release
catalog with a closed `eliza.provider-qualification-catalog-config.v2` file:

```json
{
  "schema": "eliza.provider-qualification-catalog-config.v2",
  "expectedRepositorySha": "0123456789abcdef0123456789abcdef01234567",
  "artifactFiles": [
    "bluebubbles/qualification.json",
    "discord/qualification.json",
    "duffel/qualification.json",
    "gmail/qualification.json",
    "google-calendar/qualification.json",
    "google-sheets/qualification.json",
    "signal/qualification.json",
    "slack/qualification.json",
    "telegram/qualification.json",
    "twilio-sms/qualification.json",
    "twilio-voice/qualification.json",
    "whatsapp/qualification.json",
    "x-dm/qualification.json"
  ],
  "outputDir": "catalog-output"
}
```

```bash
bun run --cwd packages/scenario-runner provider-qualification -- \
  catalog /absolute/path/to/catalog-config.json
```

List all 13 artifact files in canonical scenario order in the real config. The
catalog command compares their signed scenario IDs to the repository-owned
`PROVIDER_CANARY_SCENARIO_IDS` inventory; callers cannot redefine completeness.
It rejects missing, extra, reordered, or substituted scenarios, modified
artifact digests, unqualified decisions, repository drift, and mixed
deployments before writing `catalog.json` and the PR/issue-ready `catalog.md`.

When the catalog is run through the coordinated matrix producer, its private
JSON and all verifier JSON stay in a mode-0700 temporary directory. The
producer supplies the staged artifact paths and catalog output directory; the
corresponding fields in the operator's direct-CLI configs are not publication
destinations in this mode.

## Evidence scopes

`evidenceScope` describes the claim a scenario is designed to support; it does
not change where the scenario runs (`lane`) or how trustworthy its evidence is
(`executionProfile`):

- `runner-fixture` — runner, schema, or interception behavior only.
- `domain-contract` — deterministic domain/state-machine behavior.
- `model-behavior` — model selection, extraction, or response quality.
- `connector-contract` — a connector adapter exercised against deterministic
  fixture infrastructure; it is still simulated and does not prove delivery.
- `provider-certification` — qualified external provider evidence only.

The schema keeps `runner-fixture` as a compatibility default for external
callers, and reports count every use. Maintained corpora must classify the field
explicitly; the shared and personal-assistant corpus gate requires a zero
default count.
`provider-certification` and `executionProfile:
"provider-qualified"` must be declared together. A simulated pass is never
provider certification, including when it used a live model or real plugin
code.

Planned behavior that is not yet executable must use `status: "pending"` with
an explicit dependency in its title or description. Pending definitions remain
inventory-visible but are excluded from ordinary execution unless
`SCENARIO_INCLUDE_PENDING=1`; do not encode an unrelated fallback as a passing
implementation or delete the definition to hide the gap.

An invalid historical claim may instead be retired when the product capability
was deliberately removed, the scenario was renamed without changing its
contract, or a stronger scenario covers the same behavior. Every retirement
must be recorded in the corpus `_scenario-retirements.json` manifest as
`removed`, `renamed`, or `covered-by`, with a live replacement or checked source
evidence. Unsupported behavior that is still planned is not a retirement.

## Key env vars

| Variable | Effect |
|---|---|
| `SCENARIO_USE_DETERMINISTIC_MODEL=1` | Use the deterministic fixture-based model provider (no API key needed) |
| `LIFEOPS_LIVE_JUDGE_MIN_SCORE` | Minimum judge score threshold (default: `0.8`) |
| `SKIP_REASON` | Set to allow intentional scenario skips without exit code 2 |
| `SCENARIO_INCLUDE_PENDING` | `1` = include `status: "pending"` scenarios |
| `ELIZA_BENCH_SKIP_EMBEDDING` | Simulated runs default to no embedding provider; set to `0` for real local-inference embeddings |
| `ELIZA_TRAJECTORY_LOGGING` | The `run` command sets this to `1` when the operator has not already set it, so scenario trajectories are recorded even under `NODE_ENV=test` or `NODE_ENV=production`; explicit `0` and `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` are respected |
| `ELIZA_TRAJECTORY_DIR` | Set automatically when `--run-dir` or `--export-native` creates an effective run directory; otherwise the recorder falls back to the state-dir trajectories path |

Any one of `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENROUTER_API_KEY` satisfies the live-provider requirement when deterministic mode is disabled.

## Programmatic use

```ts
import { createScenarioRuntime } from "./src/runtime-factory.ts";
import { runScenario }           from "@elizaos/scenario-runner";

const { runtime, providerName, cleanup } = await createScenarioRuntime();
const report = await runScenario(myScenario, runtime, {
  providerName,
  minJudgeScore: 0.8,
  turnTimeoutMs: 120_000,
});
await cleanup();
```

## Notes

- A simulated CLI invocation runs its scenarios in one shared runtime because PGLite cannot be recreated in-process. Provider-qualified definitions are restricted to one scenario and still require an external production controller; the ordinary executor deliberately refuses to qualify them.
- Schema types (`ScenarioDefinition`, `CapturedAction`, etc.) come from `@elizaos/scenario-runner/schema`, not from the main export.
- Scenarios starting with `_` or in directories starting with `_` are skipped by the loader.
