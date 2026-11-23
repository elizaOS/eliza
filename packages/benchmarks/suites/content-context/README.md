# Content-context benchmark

Owns synthetic corpus generation, fixed performance policy and target
measurement. Shared adapter and conformance contracts
remain in `@elizaos/testing/progressive-content`; this suite does not implement
production storage. Operational fault fixtures cannot qualify production evidence.

Consumers import `elizaos-benchmarks/content-context`. Preserve complete
payloads, source identities, receipts, and explicit limits.

From the repository root, run `bun run build:core`, then
`bun run --cwd packages/benchmarks test:content-context` and
`bun run --cwd packages/benchmarks typecheck:content-context`.
The full corpus-size test retains 1, 10 and 100 MiB coverage.
