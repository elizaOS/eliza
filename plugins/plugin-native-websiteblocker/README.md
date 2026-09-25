# @elizaos/capacitor-websiteblocker

Capacitor plugin that enforces website blocking across browser, Android (split-tunnel
VPN DNS), and iOS (native Safari content blocker) from a single TypeScript API surface.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-websiteblocker build  # build
bun run --cwd plugins/plugin-native-websiteblocker test   # tests
```

## Android device verification

Run `node packages/app/scripts/android-native-plugins.ts --plugin plugin-native-websiteblocker --serial <emulator>` from the repository root. Tests grant Android VPN consent and send real DNS traffic: blocked and allowed hostnames, live policy replacement, system resolver behavior, explicit stop, one-minute expiry, and restart. The emulator needs working upstream DNS. Packet transcripts are exported with the runner report. This verifies the DNS VPN path; encrypted/custom DNS and reboot restoration require separate coverage.

Add `--dns-outage` on an isolated rooted stock emulator without the user app to
drop upstream DNS replies and verify blocked responses remain prompt while all
forwarding workers are occupied, and overload returns DNS SERVFAIL. Both device and
host clean up the unique firewall chain. The scenario also verifies VPN stop cancels
sockets and workers.
