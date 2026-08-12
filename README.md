<div align="center">
  <img src="packages/shared/assets/banners/elizaos_banner.svg" alt="elizaOS" width="100%" />
  <h1>elizaOS</h1>
  <p><strong>Your agentic operating system.</strong></p>
  <p>
    <a href="https://eliza.app">Eliza</a> ·
    <a href="https://app.elizacloud.ai">Eliza Cloud</a> ·
    <a href="https://os.elizacloud.ai">elizaOS downloads</a> ·
    <a href="https://docs.elizaos.ai/">Documentation</a> ·
    <a href="https://plugins.elizacloud.ai">App catalog</a>
  </p>
</div>

elizaOS is an open-source TypeScript framework and product stack for autonomous
AI agents. This monorepo contains the core runtime, the Eliza app, the CLI,
cloud services, native bridges, and first-party plugins. The bootable Linux and
Android distributions live in the separate
[`elizaOS/os`](https://github.com/elizaOS/os) repository.

## Choose a starting point

| Goal | Start here |
| --- | --- |
| Use Eliza | [Open the web app](https://app.elizacloud.ai), visit [Eliza downloads](https://eliza.app/downloads), or use a published [GitHub release](https://github.com/elizaOS/eliza/releases) |
| Run this repository | Follow [Run Eliza from source](#run-eliza-from-source) |
| Build an agent or plugin | Install the [`elizaos`](#build-with-elizaos) CLI and read the [developer docs](https://docs.elizaos.ai/) |
| Contribute | Read [CONTRIBUTING.md](CONTRIBUTING.md) and the repository guide in [AGENTS.md](AGENTS.md) |
| Run a whole device as elizaOS | Use the installers and target guides in [`elizaOS/os`](https://github.com/elizaOS/os) |

## Run Eliza from source

The repository pins Bun and Node versions in [`package.json`](package.json).
Install those versions, then:

```bash
git clone --filter=blob:none https://github.com/elizaos/eliza.git
cd eliza
bun install
bun run dev
```

`bun install` also prepares submodules, patches, and runtime artifacts. For a
smaller development install that skips the large artifact bundle, use
`bun run install:light`.

Common repository commands:

```bash
bun run build       # build the workspace with Turbo
bun run verify      # package parity, dependency, type, lint, and audit gates
bun run test        # repository unit/integration test lane
bun run test:e2e    # end-to-end lane
bun run cloud:mock  # local Eliza Cloud stack with mocks
```

See [AGENTS.md](AGENTS.md) for package scoping, shared development servers, and
the evidence required before a change is considered complete.

## What is in the stack?

### Eliza

Eliza is the user-facing agent app for web, desktop, and mobile targets. Its
capabilities are supplied by the runtime and installed plugins, including:

- chat, voice, memory, knowledge, and document workflows;
- messaging and workspace connectors;
- calendar, reminders, inbox, goals, health, and other personal-assistant
  domains;
- browser and desktop automation;
- camera, phone, messages, contacts, location, and other native device bridges;
- non-custodial EVM and Solana wallet operations with approval boundaries; and
- scheduled workflows, coding-agent orchestration, and installable app views.

Availability depends on the operating system, installed plugins, granted
permissions, and configured model or service providers. Package-level READMEs
document the exact support and setup for each capability.

### The framework

The framework is model-agnostic and extended through plugins:

- [`@elizaos/core`](packages/core) defines `AgentRuntime`, the canonical types,
  the message loop, memory and state primitives, and plugin contracts.
- [`@elizaos/agent`](packages/agent) assembles a standalone agent and HTTP
  backend around the core runtime.
- [`@elizaos/app-core`](packages/app-core) provides shared application hosting,
  API, and platform orchestration for Eliza app targets.
- [`@elizaos/ui`](packages/ui) contains the shared React UI used by app
  surfaces.
- [`elizaos`](packages/elizaos) is the project and plugin scaffolding, upgrade,
  and deployment CLI.

A plugin exports a `Plugin` object. Plugins can register actions, providers,
evaluators, services, model handlers, routes, events, tests, and app views. See
the [plugin component guide](https://docs.elizaos.ai/plugins/components) and
the first-party implementations under `plugins/`.

### Local inference

[`@elizaos/plugin-local-inference`](plugins/plugin-local-inference) provides the
Eliza-1 on-device path. The current Eliza-1 registry contains 2B, 4B, 9B, and
27B text tiers based on Gemma 4, plus local embeddings, speech, vision, and
image-generation assets. Hardware detection and model routing select supported
backends; after the required assets are downloaded, eligible operations can run
without a network connection.

Local inference is not forced on hardware that cannot support it. Eliza can
route each model capability to local, direct-provider, or Eliza Cloud backends.

### Eliza Cloud

[Eliza Cloud](https://app.elizacloud.ai) is optional. It provides account and
authentication services, hosted model routing, application and agent
deployment, remote connectivity, and cross-device product services. The local
runtime and direct model-provider configuration remain first-class paths.

### elizaOS distributions

The standalone [`elizaOS/os`](https://github.com/elizaOS/os) repository owns
bootable Linux and AOSP distributions, installers, release manifests, and OS
toolchains. This monorepo retains the Eliza application shells and native
runtime bridges used by desktop, iOS, Android, and device integrations.

## Build with `elizaos`

The beta CLI published from this branch uses the unscoped `elizaos` package:

```bash
bun add --global elizaos@beta
elizaos create my-project --template project
elizaos create plugin-example --template plugin
```

Projects are deployable workspaces; plugins are reusable capability packages.
The packaged templates and their scaffold contracts live in
`packages/elizaos/templates/`.

To embed the runtime directly without the CLI or application host, import
`@elizaos/core`. The scenario runner provides executable integration coverage
against a real runtime and, when configured, live models.

## Repository map

```text
packages/        runtime, hosts, UI, CLI, docs, cloud, native code, and tooling
plugins/         first-party model, connector, domain, app, and device plugins
scripts/         repository-wide checks, test orchestration, and release tools
patches/         dependency patches applied during installation
```

Every maintained package or plugin should explain its public surface, scripts,
configuration, and local constraints in its own `README.md` and paired
`CLAUDE.md` / `AGENTS.md`. Read the nearest package guide before making changes.

## Contributing

Open an issue before a non-trivial change and submit work through a pull request
against `develop`. [CONTRIBUTING.md](CONTRIBUTING.md) defines the coordination,
testing, synchronization, and human-verifiable evidence requirements.

- [Bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.md)
- [Agent work item](.github/ISSUE_TEMPLATE/agent_work_item.md)
- [Windows setup](WINDOWS.md)
- [Security policy](SECURITY.md)
- [Security architecture documentation](packages/docs/security.md)

Report vulnerabilities privately through the [security policy](SECURITY.md),
not a public issue.

## License

[MIT](LICENSE)
