# Eliza on Vibestack

This workspace specifies Eliza v4 on Vibestack: the kernel, the agent host,
auth, the device image, the cloud services and the assistant plugins. The
specification covers requirements, Quint models, and the generated
contracts for the VibeLang and Effect implementation.

Start with [the package specifications](spec/index.md),
[the agent procedure](AGENTS.md) and [the spec reference](SPEC.md).
The source baseline is Eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The orphan `vibestack` branch
starts from elizaOS/eliza-vibestack commit
`71d7b30f404b91d7ec48741ac288d6c8d911f3e2`; its toolchain is merged from
lalalune/vibestack commit `45cc5c35d58b8dc18b0a57b116fde2386eef5528`.

The vendored Vibestack toolchain is synchronized with upstream commit
`fd4f726016c0e2b465bc6dc7a02abebc0c2e0fb3`.

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
review. `pnpm accept` records the user's review. Each package's shell is
implemented from its accepted specification.

[The Vibestack toolchain guide](vibestack/README.md) explains Studio,
commands, examples and generated files. [Contributing](CONTRIBUTING.md)
describes the repository checks. The MIT license is in [LICENSE](LICENSE).
