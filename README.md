# Eliza on Vibestack

The specification-first replacement for `@elizaos/core`, built with
VibeLang and Effect. This phase contains core research, stories, formal
models and generated contracts. Runtime implementation follows review of
the complete specification.

Start with [the core specification](spec/core/index.md),
[the agent procedure](AGENTS.md) and [the spec reference](SPEC.md).
The source baseline is Eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The orphan `vibestack` branch
starts from elizaOS/eliza-vibestack commit
`71d7b30f404b91d7ec48741ac288d6c8d911f3e2`.

## Setup and verification

Use Node 26, pnpm 10.24.0 and Dafny 4.11.

```sh
pnpm install --frozen-lockfile
pnpm gen
pnpm check
pnpm verify
```

`pnpm check` generates the contracts, checks model traces and replay,
proves safety obligations, runs available journeys, and lists changes for
review. `pnpm accept` records the user's review. The imported application
in `apps/app` exercises the toolchain. Core implementation and npm
consumer acceptance are separate later work.

[The Vibestack toolchain guide](vibestack/README.md) explains Studio,
commands, examples and generated files. [Contributing](CONTRIBUTING.md)
describes the repository checks. The MIT license is in [LICENSE](LICENSE).
