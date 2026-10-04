# @elizaos/auth

Shared login, account sessions, OAuth, and encrypted credential storage for elizaOS.

The root SDK is browser-safe. Use explicit Node subpaths for account authentication,
vault, and KMS. Preserve encrypted-storage compatibility and per-account refresh
coordination; never log credentials.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/auth build  # build
bun run --cwd packages/auth test   # tests
```

## Native host enrollment

`@elizaos/auth/native-host` exports `createNativeCloudAuth` for a trusted Node
gateway. Supply the registered `binding` (clientId, environment, HTTPS
redirectUri), `appName`, optional `deviceName` and presentation `messages`, an
encrypted `pendingStore` with async read/write/clear, and an `activate(secret,
guard)` callback. Activation must call guard immediately before committing.
Supply readActive/clearActive to support recoverable disconnect. Keep these
callbacks and all credential storage outside the renderer.

The host retains email/phone verification, PKCE, durable acknowledgement,
cancellation fencing and remote revocation receipts. Hosts own registration,
copy, encrypted persistence and application UI. The browser-safe root SDK does
not import this Node entrypoint. Run `bun run --cwd packages/auth test:native-host`
for synthetic lifecycle tests; these do not establish live provider acceptance.
