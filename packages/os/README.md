# @elizaos/os

Android vendor overlays and their release tooling.
The built-in Chromium component of the AOSP image lives in `browser/`. Its Linux
native-message relay is retained there for the browser tests; no image ships it.
Build it with `bun run --cwd packages/os build:browser`; run its protocol and
Chromium patch tests with `bun run --cwd packages/os test:browser`.

Application and native-runtime sources belong to `packages/app` and its plugins.
Builders use the enclosing Eliza checkout, or `ELIZAOS_ELIZA_ROOT` when explicitly
set.

Install workspace dependencies with Bun 1.4.2 at the repository root. Use Bun
for scripts and Node 24.15.0 for the retained Node lanes. From the repository root:

```bash
bun run --cwd packages/os build                 # browser component
bun run --cwd packages/os verify:portable       # typecheck, lint and tests
bun run --cwd packages/os verify                # portable and release checks
make -C packages/os/android bootstrap AOSP_ROOT=/path/to/aosp
make -C packages/os/android build ARCH=x86_64 AOSP_ROOT=/path/to/aosp
```

OS image builds are separate from the package build. See
[Android](android/README.md) for their entrypoints.

Release-script tests (`test:release`) require Python 3.11+, cryptography, binutils
(`readelf`) and e2fsprogs (`mkfs.ext4`, `debugfs`) on `PATH`. Linux CI owns the
complete native and release lane; portable checks do not qualify device writes.
Browser tests additionally require a JDK, C++20 compiler and OpenSSL development
headers/libraries on the compiler search path.
`test:ota-publisher` also requires the exact Go version in `native/ota-trust/go.mod`;
its signed-graph integration test fails when that toolchain is missing.

`native/ota-publisher` contains the provisioned OTA publisher's durable version
allocator, metadata transaction journal, rollback floors and strict descriptor
parser. Hosts supply verified authorization, immutable storage and atomic timestamp
CAS ports; the core has no default signer or publication destination. Run
`bun run --cwd packages/os test:ota-publisher` for concurrency and real process-death
recovery contracts. These tests do not authorize or perform production publication.

`createPublicationAuthorizer` (`native/ota-publisher/publication-authorizer.mjs`)
builds the transaction's `authorizeBundle` port. Each call reads the durable
floors and the host's qualified publisher time, verifies the complete signed
graph, binds every descriptor in the plan to it, and gets a fresh source approval
and preflight report for each exact descriptor. It then verifies the graph again
and only then advances the floors. `verifyPublicationGraph` runs the shared
`ota-trust/cmd/verify-publication` executable with a host-supplied path,
`AbortSignal` and `timeoutMs`. There are no default deadlines, request budgets or
transport, and no APK or public-release verifier: those stay with the host.

Downstream launcher hosts may use `createDevelopmentLauncherDescriptor` from
`scripts/android/stage-launcher-overlay.ts` only with explicit development
mode. It verifies one signer against a private APK copy and returns a hash-bound
descriptor; it grants no production signer authority. `stageLauncher` rechecks
the staged bytes, manifest and signer, and accepts an optional SDK environment.
Optional same-signer companion packages are staged beside the launcher without
grants or privileged placement.
Product identity, output selection and independently reviewed production
descriptors remain with the consumer.
