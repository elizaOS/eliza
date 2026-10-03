# @elizaos/testing/scenario-runner

Lean end-to-end scenario runner for elizaOS agents.

This directory is part of `packages/testing`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/testing test
```

The candidate-only planner worker accepts a complete JSON case validated by
`src/gepa-planner-case.ts`:

```bash
bun --conditions=eliza-source packages/testing/scenario-runner/src/gepa-planner-case-process.ts CASE.json
```

It runs the real planner and model dispatch with an isolated PGlite runtime,
explicit loopback fixture transport, and no effectful tools or inherited provider
credentials. Candidate instructions use the canonical artifact/provenance contract
without activating the prompt store. Evidence includes complete inputs, HTTP
bodies, planner output, hashes and per-call latency/usage (missing usage is null),
under `test-results/gepa-case-worker/`. Declared request limits reject complete
unsupported requests; they never clip inputs. The caller must retain full context
in every required dynamic field.

The narrow producer invokes the pinned upstream GEPA reflection/selection engine
with complete isolated planner cases. Prepare its separate Python 3.14.6
environment explicitly (network installation is never part of ordinary unit tests):

```bash
bun run --cwd packages/testing gepa:setup
bun run --cwd packages/testing test:gepa
GEPA_PYTHON="$PWD/test-results/gepa-producer/venv/bin/python" bun --conditions=eliza-source --tsconfig-override "$PWD/tsconfig.json" packages/testing/scenario-runner/src/gepa-producer.ts MANIFEST.json ADAPTER.ts
```

`runGepaPlannerOptimization` defines the manifest and trusted host adapter API.
The adapter exports `evaluate(evidence, case, signal)` returning a finite score
from 0 to 1 plus diagnostics, and `reflect(completePrompt, signal)` returning the
complete proposed instruction. Give both adapters explicit identities in the
manifest. The API also requires tracked `adapterSourcePaths`; API callers assert
that these files define their callbacks. The CLI binds its actual tracked adapter
module. Producer, engine and adapter sources are rechecked before publication;
this is not an attestation of arbitrary callable identity or third-party packages.
Train/validation/test scenario families must be disjoint; upstream
keeps held-out cases outside reflection and scores baseline/candidate afterward.
Budgets cover optimization calls; held-out calls are additional and recorded.
The CLI writes the canonical `artifact.json` and full `evidence.json` under
`test-results/gepa-producer/`; the two files publish atomically after source and cancellation checks. It never
calls `setPrompt`. Missing usage/cost is
unavailable, not measured zero. Interrupts cancel the engine and active workers.

The deterministic lane executes real upstream GEPA with fixture callbacks. It
proves optimizer execution and artifact plumbing, not a live Qwen improvement,
action-receipt qualification, promotion or rollback. A real-provider adapter,
behavior-specific evaluator and reviewed promotion remain separate work.
Historical #9429/#9543/#11901 inform candidate/evaluation separation; the retired
training plugin and its automatic apply path are not restored.
