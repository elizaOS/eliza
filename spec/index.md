# Eliza

Eliza's replacement runtime kernel is specified with its VibeLang and
Effect implementation. The target is a replacement for `@elizaos/core`
with a public Promise-based facade and browser-safe protocol exports.
Preserving current consumer contracts is a release requirement. The shell
uses Effect services and typed failures internally.

The research baseline is elizaOS/eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The imported toolchain is
lalalune/vibestack commit `45cc5c35d58b8dc18b0a57b116fde2386eef5528`.
The original core source, declarations, consumers, formal assertions and
scenario bounds are traceable from the core specification.

- [Downstream consumer contracts and models](./downstream/)
- [Core requirements and models](./core/)
- [Imported toolchain demonstration](./app/)

This workspace owns requirements, models, generated contracts, the runtime
candidate in `packages/core`, and their verification. External database,
transport, model-provider and package-consumer execution still require
their own implementation acceptance. The imported demonstration remains
available for checking the toolchain.
