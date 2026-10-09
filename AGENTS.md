# elizaOS

Monorepo for the Eliza agent runtime, application, cloud services, native
bridges, benchmarks, and first-party plugins. Read [CONTRIBUTING.md](CONTRIBUTING.md)
and the owning package's `README.md` before editing; manifests and source are
authoritative. This root file is the only repository agent guide. Do not add
nested `AGENTS.md` files.

> [!IMPORTANT]
> **The [contribution rules](CONTRIBUTING.md) are required for all issues
> and PRs.** Report real bugs or missing approved MVP requirements. Link the PRD
> and MVP plan. Do not add features outside that scope. Human maintainers must
> discuss and approve new features, then add them to the PRD and MVP plan before
> implementation issues or PRs are opened. Maintainers will close unnecessary
> work and apply contributor penalties.

- **Human-only issue creation:** Outside contributors must personally write the
  issue title and body and submit the issue by hand on the GitHub website.
  Agents must not write or create issues for contributors. Do not use an API,
  CLI, browser automation, or another agent to submit an issue. Human approval
  of an agent-written issue does not meet this rule. An agent that finds a
  problem must report it privately to the human in the current work session;
  the human decides whether to write and submit an issue.
- Prove a useful improvement with before-and-after behavior or relevant scores.
  Prefer cleanup, removal, and reuse. Combine duplicate types and functions.
  Add new types or code only when necessary. Explain the research, alternatives,
  and reason for the chosen implementation.
- Do not create work for minor points with no useful effect, unnecessary tests,
  defensive code, validation, or truncation. Preserve required safety boundaries.
- Validate real behavior end to end and attach results for the reviewed commit.
  Use existing tests. Avoid new unit tests, mock-only proof, and tests that repeat
  the implementation. For documentation-only work, check the text and links.
- Every UI PR must include an uploaded MP4 explainer and walkthrough with video
  evidence of the complete user flow, plus detailed steps to test the change.
- Write all issues and PRs in ASD-STE100 Simplified Technical English. Use short,
  direct sentences, explain technical terms, and write for a non-technical reader.

- Preserve unrelated changes in this shared working tree.
- Use pinned Bun 1.4.2 and Node 24.15.0, ESM, and the repository's Biome config.
- Keep core independent of hosts; hosts compose assistant behavior, storage,
  and model providers. Validate untrusted input at boundaries.
- Preserve authorization, tenant isolation, cancellation, and effect receipts.
  Throw typed errors; never fabricate success or hide failures as empty data.
  Use the structured logger and `runtime.reportError` for runtime diagnostics.
- Keep model-facing context and recorded training data complete. Preserve the
  existing authorized source-selection/restoration contract; do not add silent
  truncation, summaries, or recency limits. Reject hard size limits explicitly.
- Use the existing scheduler, entity/relationship stores, and content-addressed
  media store. Do not introduce parallel ownership or bypass SSRF guards.
- Keep READMEs and agent guides short. Retain other Markdown only when consumed
  by runtime, build, tests, publishing, or required attribution. Generated
  reports belong in ignored repository-root `test-results/`, with one leaf per producer.
  Use `packages/scripts/lib/test-output.ts` for stable output paths.
- Verify changed behavior with the owning package's tests, typecheck, and lint,
  then `bun run verify`. Validate documentation links for docs-only changes.
  UI changes require the app visual audit and desktop/mobile inspection.
- Submit changes through a PR against `develop`. Report vulnerabilities
  privately through GitHub Security Advisories. The community plugin registry
  is retired; first-party catalog data lives in `packages/core/src/catalog/`.

Getting started, build, test, and benchmark commands: [README.md](README.md).

Design inventories are advisory; do not gate builds on saved component counts,
story percentages, or expired review metadata.
