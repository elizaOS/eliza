# Eliza

Eliza's replacement runtime kernel is specified before its VibeLang and
Effect implementation. The target is a replacement for `@elizaos/core`
with a public Promise-based facade and browser-safe protocol exports.
Preserving current consumer contracts is a release requirement. The shell
will use Effect services and typed failures internally.

The research baseline is elizaOS/eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The imported toolchain is
elizaOS/eliza-vibestack commit `71d7b30f404b91d7ec48741ac288d6c8d911f3e2`.
The original core source, declarations, consumers, formal assertions and
scenario bounds are traceable from the core specification.

- [Downstream consumer contracts and models](./downstream/)
- [Core requirements and models](./core/)
- [Imported toolchain demonstration](./app/)

This phase owns requirements, models, generated contracts and verification.
External database, transport, model-provider and package-consumer execution
belongs to implementation acceptance after the core shell exists. The
imported demonstration remains available for checking the toolchain.
