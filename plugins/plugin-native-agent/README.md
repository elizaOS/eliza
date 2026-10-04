# @elizaos/capacitor-agent

Capacitor plugin that exposes agent lifecycle control (start, stop, status, chat, raw
request) to a WebView-hosted Eliza app on iOS, Android, and web/desktop.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-agent build  # build
bun run --cwd plugins/plugin-native-agent test   # tests
```

Native-only host primitives live under Android `runtime/` and `updater/` Java
packages. They share payload extraction, installation identity, request deadlines,
update journaling, qualified-clock projection and cancellable job ownership.
Hosts supply the inventory format, durability/clock adapters and release policy;
these APIs neither authorize an installation nor expose renderer capabilities.
File-based primitives require Android API 26 or newer. Run their portable JVM
crash/recovery tests with JDK 21 and `bun run test:native-host`.

The Android updater `PackageInstallCoordinator` shares package/session validation,
commit and installed-identity reconciliation on API 29+. Hosts supply target
identity, distribution metadata, callback receiver/action, signer, journal,
observation budget and authenticated trust hooks. Production verification remains
mandatory alongside those hooks; test APK acceptance requires explicit host
opt-in. `PreparationFlow` fences each long operation by generation, installed
identity and cancellation. It cannot install packages or select a trust authority.
Its portable contract is included in `test:native-host`. Qualify the host adapter
separately with real Android install/recovery tests; journal tests alone do not
prove silent-install authority or product health.
`LocalCredentialBroker` is a private loopback HTTP transport for the embedded
native process. Hosts inject separate primary and pending-enrollment stores plus
a nonempty private token. It is not a Capacitor method: do not pass that token or
credential responses to the renderer. The host owns token generation and broker
lifetime. Storage failures return a generic error without credential logging.
`LocalCredentialBrokerInstrumentedTest` exercises the TCP contract on Android;
the same contract has a `main` entrypoint for JDK 21 with `org.json` on the classpath.
Consumers should additionally test their real encrypted-store adapter and restart
lifecycle. This transport does not authenticate a Cloud account by itself.

`LocalRuntimeHttp` supplies bounded JSON HTTP exchange with an absolute socket
deadline and injected monotonic clock. It only connects to loopback; the host
must authorize its route and provide its private token and response-size limit.
It deliberately contains no product route catalog. The instrumented contract
also covers this client with real fixed-length, chunked, close-delimited,
oversized, truncated and delayed responses.

`AndroidRuntimeDirectories` supplies the Android durability adapter for runtime
bundle publication and secures an app-owned parent directory to mode 0700.
It rejects symlinks and foreign ownership, and verifies inode identity after
chmod. Hosts retain directory layout and startup policy. Its Android instrumented
test exercises real permissions and fsync, including invalid targets.

`native-host/android-runtime-inventory.mjs` stages the matching Android bundle
inventory from an explicit agent asset directory and native library directory.
Archive blobs preserve gzip bytes through aapt and install beside the immutable
bundle for PGlite. Hosts supply exact directory exclusions and package the
returned inventory plus assets. This does not sign or authorize a release.
The native host suite consumes a Node-produced inventory with the actual Java
extractor and checks restart reuse, archive bytes and tamper rejection.
