# Evidence and review rubric

Proof must let a reviewer confirm real behavior without reading the implementation. Attach evidence inline to the issue or PR; do not commit it to the repository. Capture first, then open and inspect every artifact yourself.

## Evidence by surface

| Change surface | Minimum proof |
| --- | --- |
| UI | Before and after full-page desktop and mobile screenshots, an MP4 walkthrough of the full flow, frontend console and network logs, backend logs when a server path fires, and the repository-required OCR/visual review |
| Agent, action, provider, prompt, or model | A live-model trajectory containing inputs, context, raw output, tool/action calls, and results; name the exact provider and model |
| Native, mobile, desktop, or device | Current-build proof plus per-platform screenshots, recordings, logs, and device or simulator output |
| Server/runtime | Structured logs showing the real path end to end and resulting state or domain artifacts |
| Data/domain | The actual DB rows, memories, scheduled tasks, generated files, wallet balances, transaction hashes, audio, or device output |
| Documentation-only or non-runtime metadata | Focused validation output; mark unrelated template rows `N/A - <specific reason>` |

Keep all seven stable PR-template rows: before screenshots, after screenshots, walkthrough video, backend logs, frontend logs, real-LLM trajectory, and domain artifacts. A checked box alone is not evidence. A bare `N/A`, placeholder, or link to an unrelated page is not evidence. Rendered UI changes require concrete visual media even when labels are missing.

Useful repository commands include:

```bash
bun run evidence:doctor -- --strict
packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out.json>
bun run test:e2e:record:review
bun run test:matrix:review
bun run --cwd packages/app audit:app
```

The coordinated matrix path must create one named
`evidence/runs/<run-id>` bundle, verify its manifest and artifact hashes, and
hand that exact bundle to the reviewer. Inspect the run's `meta.json`,
`manifest.json`, and copied artifacts yourself; for standalone review, run
`bun run --cwd packages/evidence bundle:verify -- evidence/runs/<run-id>` before
`bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>`.
Raw-directory review is compatibility-only and must name every input with
`--source`; it must not replace the verified-bundle flow or choose inputs
implicitly by recency.

Follow package-local capture commands for native platforms. Upload screenshots as JPG where practical, videos as MP4, and long logs in a `<details>` block. Re-run and re-capture after a behavior-changing rebase.

## Implementation completion rubric

- Acceptance criteria map to code, tests, and proof with no hidden scope expansion.
- Required DTO values and collaborators remain required; failed or missing data does not become a healthy empty or zero state.
- Inner failures throw typed errors; only designated boundaries translate them. Any retained handler follows the repository's documented J1–J7 policy.
- Tests drive the real system under test and cover success, failure, empty/invalid input, permissions, concurrency, and adversarial input where relevant.
- Formatting, typecheck, build, focused tests, and repository verification run on the final synced head.
- Documentation and package-local guidance match the shipped behavior.
- No TODO, stub, mock standing in for the changed behavior, committed evidence bundle, or unrelated cleanup remains.

## Independent PR review rubric

1. Confirm the PR's scope matches its linked issue and the diff contains no unrelated behavior.
2. Trace changed data across boundaries; check validation, authorization, secret handling, SSRF/file handling, error propagation, and observable failure states.
3. Read every affected package guide and verify the implementation follows its architecture.
4. Reproduce the old failure or stated need, then exercise the changed path independently.
5. Inspect tests for meaningful assertions and missing negative, role, concurrency, and integration cases.
6. Verify the branch is current with `origin/develop` and checks were run after sync.
7. Open every attached trajectory, log, screenshot, recording, and domain artifact. Compare it to the acceptance criteria and look for stale builds, hidden errors, clipped states, or mismatched model identity.
8. Audit the PR template: every evidence row is concrete or carries an allowed specific `N/A` reason, and the PR body plus every contribution comment discloses the exact provider/model.
9. Separate blocking findings from optional suggestions. Cite the smallest relevant line range and state the consequence plus a verifiable repair.
10. Require another reviewer for repairs you authored. Never self-approve or self-merge.
