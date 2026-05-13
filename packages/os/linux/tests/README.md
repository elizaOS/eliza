# Tests

This tree holds tests that don't fit inside a single crate or workspace member.

## Layout

```
tests/
├── integration/    # cross-crate Rust tests against a running eliza-agent
├── smoke/          # the 5 canonical app intent scenarios (calendar, notes, editor, clock, calculator)
└── fixtures/       # bad-manifest examples, expected screenshots, calibration fixtures
```

In-crate unit tests stay alongside their source (`src/foo.rs` next to `src/foo.rs::tests`).
Cross-crate or VM-driven tests land here.

`just vm-test` picks up `tests/smoke/*.scenario` files; the format is documented in
`vm/scripts/inject.py` (milestone #9).
