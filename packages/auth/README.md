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

The stored app credential stays inference-only. A successful code `verify`/`mfa`
also keeps that Steward session in memory as billing authority, bound to the
activated credential. `await auth.billingAuthority()` returns `{token, expiresAt}`
or `null`. Use it only as `Authorization: Bearer` on organization billing routes
from the trusted host, and never return it to a renderer. It is cleared on
`cancel`, a new `start`, `clearBillingAuthority()`, expiry (JWT `exp`, at most
one hour), or when the active credential changes. When it is missing (for
example after a restart, or for Google/CLI keys), `billing-start` (`{method?,
email?, phone?}`, defaulting to the account's own email, then phone) and
`billing-verify`/`billing-mfa` (`{sessionId, code}`) repeat the code check.
They never re-enroll or write storage, and they reject a different
user/organization with `code: "billing_account_mismatch"`. `billing-status`
returns `{status: "authorized", expiresAt}` or `{status: "required"}`.

## Native Cloud service composition

`native-host/cloud-services/cloud-services.mjs` is a Node source entrypoint for
verified native gateway payloads. It shares private credential persistence,
account epochs, Cloud login/billing transport, speech framing, account-bound
Google reads and document-runtime authority/provenance checks. It does not
provision a remote agent or expose account API credentials to the renderer.
The checkout projection intentionally returns only provider-scoped payment UI
fields. The document loader requires the host to supply the reviewed source commit and
canvasVersion explicitly; artifact provenance must match both.

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

Service-only consumers set `hostPolicy.accountBilling: false` to exclude account
billing routes and avoid supplying an unused checkout policy. Native enrollment
still requires its factory when a pending credential store is supplied. Explicit
`providerDefaultVoice: true` permits omitted voice IDs; `speechLanguage: null`
uses provider language detection. Omitting these choices retains policy validation.
