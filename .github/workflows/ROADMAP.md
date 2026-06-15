# CI Workflow Roadmap

This roadmap is for making CI faster and friendlier without weakening the
quality gate.

## Principles

- Prefer affected-surface execution over blanket PR execution.

  Why: contributors should not wait on unrelated platform builds, but affected
  code still needs the same depth of verification.

- Keep broad verification on push, schedule, and manual dispatch.

  Why: selective PR checks optimize review latency; broad branch checks catch
  integration issues that only appear after many changes compose.

- Make every skip explainable and overridable.

  Why: maintainers need confidence that a skipped lane was intentionally out of
  scope, and they need a label escape hatch when judgment says to run it anyway.

- Split long serial lanes before removing coverage.

  Why: parallelism usually improves developer experience without trading away
  signal.

## Near Term

- Record workflow-level and job-level duration trends for PR and `develop`
  pushes.

  Why: the current long pole can move as workflows are split. Duration data lets
  us optimize the real bottleneck instead of guessing from one run.

- Continue splitting long jobs into independently named slices with aggregate
  status checks.

  Why: aggregate checks preserve branch-protection simplicity while named slices
  improve failure triage and parallelism.

- Expand classifier self-tests when adding a new path-gated workflow.

  Why: every new gate adds skip logic. The test suite should grow with the blast
  radius of that logic.

## Next

- Move repeated setup into reusable actions where it does not hide important
  workflow behavior.

  Why: duplicated setup makes split jobs noisy, but overly opaque setup makes CI
  harder to debug. Reusable actions should reduce repetition while keeping logs
  readable.

- Add a documented owner map for path-gate rules.

  Why: package owners can judge whether a path belongs in server, client,
  plugin, cloud, mobile, desktop, Docker, or E2E coverage better than a generic
  workflow edit can.

- Evaluate matrix shaping for Windows CI.

  Why: recent completed `develop` runs show Windows CI as the workflow-level
  long pole. More parallelism or tighter affected-surface routing there may
  produce the biggest wall-clock win.

## Later

- Publish a compact CI timing summary on PRs.

  Why: contributors should see whether the slowest check is queue time, setup,
  test execution, artifact upload, or a platform-specific lane.

- Add a periodic full-gate audit that compares path-gated PR behavior against a
  broad run for representative diffs.

  Why: selective CI needs periodic calibration so the faster path remains as
  trustworthy as the older all-in path.
