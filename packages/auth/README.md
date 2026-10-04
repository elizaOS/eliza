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

## Native Cloud service composition

`native-host/cloud-services/cloud-services.mjs` is a Node source entrypoint for
verified native gateway payloads. It shares private credential persistence,
account epochs, Cloud login/billing transport, speech framing, account-bound
Google reads and document-runtime authority/provenance checks. It does not
provision a remote agent or expose account API credentials to the renderer.
The checkout projection intentionally returns only provider-scoped payment UI
fields. The document loader needs a host-supplied canvasVersion or a
host-resolvable @napi-rs/canvas installation.

Hosts supply explicit `hostPolicy` functions (projectAccountAccess,
createNativeCloudAuth, requireNonSensitiveText, pickMessage, fundingError),
planKeys, planCurrency, planInterval, speechLanguage, multipartPrefix and presentation
messages, plus speechVoice. These are trusted host settings, never renderer
input. The host remains responsible for origin admission and authenticating
requests before this route handler. Native enrollment keeps its own registered
application identity. Document runtimes are reviewed host-owned artifacts.

These are source-composition APIs, not browser-safe root or published dist
exports. Run `bun run --cwd packages/auth test:cloud-services` for transport and
private-file tests with synthetic provider responses. Consumer tests cover
product voice, privacy, account races and installed payload dependency closure.
