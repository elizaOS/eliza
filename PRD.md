# Product quality requirements

This document records the application state-correctness requirement. Product
feature scope and the MVP plan remain subject to maintainer approval under
[CONTRIBUTING.md](CONTRIBUTING.md).

## State correctness

Every feature must be strongly modeled in Quint. The model must describe the
application state that the feature owns, the transitions it permits, and its
interactions with other state owners. Features that do not own state must
identify the existing models whose contracts they use.

Models must cover the following behavior where applicable.

- Authorization, tenant and session ownership, expiry and revocation.
- Concurrent events, resource ownership and ordering across asynchronous work.
- Cancellation, retries, duplicate delivery and unknown external outcomes.
- Persistence, restart, recovery and compatibility with existing records.
- Complete model context, source selection, evidence and effect receipts.

Each model must have executable safety invariants and progress obligations
under explicit environmental and fairness assumptions. Record finite domains
and other abstraction limits. A passing model check establishes properties of
that model within those limits. Implementation conformance checks must exercise
the corresponding real transitions and guard against model drift.

Changes must update source mappings, model cases and conformance evidence in
the same PR. Run `bun run test:quint` and the owning package's checks. Report
unmodeled behavior and failed checks explicitly. The application-wide migration
is complete only when every maintained state owner has been reviewed and its
required model and implementation checks pass.

See the [Quint workflow](packages/scripts/quint/README.md) for model layout,
commands and verification evidence.
