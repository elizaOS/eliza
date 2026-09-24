# Workflow simplification implementation plan

Owner direction, 2026-09-23: retain only full end-to-end tests. Remove unit,
mock, fixture-only, smoke, and runner self-test suites. Use a deterministic
perfect-result provider compatible with plugin-openai for model responses and
voice, while exercising the real application, transport, persistence, and
side effects. This replaces the earlier affected-unit admission proposal.

Tracking: https://github.com/elizaOS/eliza/issues/32494

## Integration and ownership

- [x] Fetch develop and shaw/mega-refactor without modifying shared changes.
- [x] Start isolated chore/e2e-workflow-consolidation from b45c2b8525;
  develop 1d072518c7 is already an ancestor.
- [x] Preserve the unpublished admission prototype as historical work only.
- [x] Separate workflow policy from the existing test/provider and script lanes.
- [ ] Integrate their reviewed commits before final validation and delivery.

## Implementation

1. Reduce canonical CI to static checks, production builds, and full E2E.
   Remove all unit matrices, mock browser suites, smoke jobs, and self-tests.
2. Remove redundant develop workflow families and their manifest rows together.
   Preserve exact-source validation, failure propagation, and deployment handoff.
3. Keep one PR authority with the existing All Tests Passed status. Retain
   mergeability, workflow syntax, affected build/lint/type checks, and full E2E;
   remove its mock billing, isolated database, and unit contract jobs.
4. Review manual, release, device, and voice workflows for retired test commands.
   Consolidate repeated test entry points without changing release permissions,
   deployment credentials, artifact requirements, or promotion authority.
5. Route surviving tests through the test owner's canonical full E2E commands.
   Missing provider scenarios must fail rather than return generic success.
   Application assertions must check resulting state, not merely provider output.
6. Remove obsolete workflow documentation and update the retained authority map.

## Verification and delivery

- [ ] Workflow syntax and local reusable-call graph are valid.
- [ ] Every retained test command resolves to full E2E; zero tests is a failure.
- [ ] No ordinary test lane requires a paid model or voice service.
- [ ] Retained full E2E commands pass on the integrated source.
- [ ] Required repository gates pass, or failures are recorded precisely.
- [ ] Deliver through a develop PR, coordinate the repair merge, and inspect
  hosted results on the merged revision without disturbing concurrent changes.
- [ ] Compare job count and completed-run work; do not claim latency savings
  from cancelled or failing runs.

Progress: source integration and ownership are established. Workflow edits,
provider adoption, test deletion integration, and terminal validation remain.
