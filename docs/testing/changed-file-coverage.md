# Changed-file coverage policy

The required `coverage-gate` workflow runs changed unit tests and enforces a
50% line-coverage floor on each changed executable source file.

## Surgical changes to legacy files

An existing file uses **changed-line mode** when all of these are true:

- it has more than `COVERAGE_DELTA_MIN_FILE_LINES` lines, default `1000`;
- added or modified lines are less than `COVERAGE_DELTA_MAX_PERCENT` of the
  current file, default `5`;
- at least one changed line has an LCOV `DA` record.

Only instrumentable changed lines are measured in that mode. New files and
larger refactors always use whole-file coverage. If a small diff contains only
non-instrumentable lines, such as types or configuration, the gate falls back
to whole-file coverage rather than passing vacuously. Deleted lines do not have
a runtime location in the new file and are not counted.

Files entirely absent from LCOV still fail closed. A confirmed instrumentation
failure can be listed temporarily in
`scripts/security/coverage-lcov-excluded.txt`; exclusions are visible in CI and
expire automatically when the file begins appearing in LCOV.

## Rationale

A whole-file floor can make a focused, tested fix impossible to land when it
touches a legacy monolith. PR #16541 demonstrated this with a four-line change
to the 5,103-line `acp-service.ts`, whose whole-file result was about 4%. PR
#16543 demonstrated the separate failure mode where large integration files are
structurally absent from LCOV. Changed-line mode measures the risk introduced by
a surgical patch while preserving full enforcement for new code and refactors;
the reviewed instrumentation exclusion mechanism remains the explicit path for
files that coverage tooling cannot collect.
