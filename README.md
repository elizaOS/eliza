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

The vendored Vibestack toolchain is synchronized with upstream commit
`146bd656ebc88851676bba744fdf247ec5399b33`.

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
gradle -p packages/os/android/passwords/test/fixture \
  -PcapacitorAndroidDir=/path/to/installed/@capacitor/android \
  :elizaos-capacitor-passwords:assembleDebugAndroidTest
adb -s emulator-5554 install -t packages/os/android/passwords/build/outputs/apk/androidTest/debug/elizaos-capacitor-passwords-debug-androidTest.apk
```

Run the focused journey from the Eliza root after `pnpm gen --owner cloud`:

```sh
PASSWORD_ANDROID_FIXTURE=emulator-5554 pnpm --filter @elizaos/cloud exec \
  vitest run test/password-backup.test.vibe -t 'Android cold start'
```

The fixture runs a save and a restore in separate Android process launches.
It installs a temporary HTTPS reverse mapping on the selected emulator and
removes it after the run. The test process trusts only its disposable cert
for these calls. The fixture browser approves a synthetic account through
the same Worker routes that the production app uses.

[The Vibestack toolchain guide](vibestack/README.md) explains Studio,
commands, examples and generated files. [Contributing](CONTRIBUTING.md)
describes the repository checks. The MIT license is in [LICENSE](LICENSE).
