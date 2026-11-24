# Eliza on Vibestack

This workspace specifies Eliza v4 on Vibestack: the kernel, the agent host,
the device image, the cloud services and the assistant plugins. Agents run
on the device; the cloud serves identity, billing and model access. The
specification covers requirements, Quint models, and the generated
contracts for the VibeLang and Effect implementation.

Start with [the package specifications](spec/index.md),
[the agent procedure](AGENTS.md) and [the spec reference](SPEC.md).
The source baseline is Eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The orphan `vibestack` branch
starts from elizaOS/eliza-vibestack commit
`71d7b30f404b91d7ec48741ac288d6c8d911f3e2`; its toolchain is merged from
lalalune/vibestack commit `45cc5c35d58b8dc18b0a57b116fde2386eef5528`.

The vendored Vibestack toolchain incorporates upstream changes through
[Vibestack `b7f1827`](https://github.com/lalalune/vibestack/commit/b7f1827be748d4a97aee094d9961371d553012a7). Eliza retains its [repository lint and verification policies](CONTRIBUTING.md).

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

### Android password recovery fixture

The Passwords instrumentation uses Android Keystore and a disposable PGlite
Cloud Worker. Use an unlocked Android 15 or later test emulator with a screen
lock and install the test APK from the portable module:

```sh
ANDROID_SERIAL=emulator-5554 gradle -p packages/os/android/passwords/test/fixture \
  -PcapacitorAndroidDir=/path/to/installed/@capacitor/android \
  :elizaos-capacitor-passwords:installDebugAndroidTest
```

Run the focused journey from the Eliza root after `pnpm gen --owner cloud`:

```sh
PASSWORD_ANDROID_FIXTURE=emulator-5554 pnpm --filter @elizaos/cloud exec \
  vitest run test/password-backup.test.vibe -t 'Android cold start'
```

For a restore into a second Android Keystore, prepare two independently created
emulators using the steps above. Set `PASSWORD_ANDROID_FIXTURE=emulator-5554,emulator-5556`
in the same command. The first device saves the vault and the second enrolls a
fresh device grant and restores into its empty vault. A single serial exercises
both phases in separate processes on that emulator.

Each phase uses a temporary HTTPS reverse mapping on its selected emulator
and removes it when the phase ends. The test process trusts only its disposable cert
for these calls. The fixture browser approves a synthetic account through
the same Worker routes that the production app uses.

[The Vibestack toolchain guide](vibestack/README.md) explains Studio,
commands, examples and generated files. The MIT license is in [LICENSE](LICENSE).

## Contributing

`vibestack` is the primary branch and the base for every pull request.
Verify through the application's normal entry points that the top-level
stories, rules, and Quint models are fully implemented and integrated.
Every change must follow them exactly. Run the full `pnpm verify` suite
and confirm that all checks pass, including Quint, Dafny, Bombadil, and
the rest of the repository tests.

In the PR description, show reproducible before-and-after results for code
changes and attach before-and-after screenshots for UI changes. Keep the
diff tidy by removing unnecessary files and dead, redundant, or superseded
code. Prose comments in code are banned. Every PR must satisfy the
Vibestack requirements and TypeScript conventions before merge.
[Contributing guide](CONTRIBUTING.md#pull-requests) · [Agent procedure](AGENTS.md#pull-requests)
