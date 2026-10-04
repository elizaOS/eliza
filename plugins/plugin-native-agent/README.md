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

`LocalCredentialBroker` is a private loopback HTTP transport for the embedded
native process. Hosts inject separate primary and pending-enrollment stores plus
a nonempty private token. It is not a Capacitor method: do not pass that token or
credential responses to the renderer. The host owns token generation and broker
lifetime. Storage failures return a generic error without credential logging.
`LocalCredentialBrokerInstrumentedTest` exercises the TCP contract on Android;
the same contract has a `main` entrypoint for JDK 21 with `org.json` on the classpath.
Consumers should additionally test their real encrypted-store adapter and restart
lifecycle. This transport does not authenticate a Cloud account by itself.
