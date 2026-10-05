# @elizaos/cloud-sdk

TypeScript SDK for the Eliza Cloud API: auth, agent management, inference, billing,
containers, and typed public-route access.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/sdk build  # build
bun run --cwd packages/cloud/sdk test  # keyless unit and transport tests
bun run --cwd packages/cloud/sdk test:e2e  # live integration tests
```

Live tests use the configured Cloud endpoints. Set `ELIZAOS_CLOUD_API_KEY` for authenticated API checks and `ELIZA_CLOUD_SESSION_TOKEN` for session checks; tests without their credentials skip. Write/generation/container checks require separate explicit opt-in flags in `src/live.e2e.test.ts`.

## Native Cloud service composition

`@elizaos/cloud-sdk/native-host` is a Node source entrypoint for
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

This Node source entrypoint is separate from the browser-safe root SDK. Run `bun run --cwd packages/cloud/sdk test:native-host` for transport and
private-file tests with synthetic provider responses. Consumer tests cover
product voice, privacy, account races and installed payload dependency closure.

Service-only consumers set `hostPolicy.accountBilling: false` to exclude billing
routes. Enrollment requires its factory when a pending credential store is supplied.
Explicit `providerDefaultVoice: true` permits omitted voice IDs; `speechLanguage: null`
uses provider language detection. Omitting these choices retains policy validation.

Use `@elizaos/cloud-sdk/testing` for deterministic setup-session mocks. The older
setup-session mock exports remain compatible; the client root does not load them.

Organization cancellation reversal can use `readOrganizationSubscriptionRenewalReview`
and `submitReviewedOrganizationSubscriptionCancellationUndo` with the returned
terms digest. These require the current billing-manager session. Display the
estimate and obtain explicit confirmation; on an unknown outcome use
`readOrganizationSubscriptionCancellationUndo` instead of inventing another intent.
The review is short-lived and does not lock a future invoice price.

Native billing also exposes management and portal projections, cancellation,
pending/status recovery and reviewed reversal. The local POST
`/cloud/account/subscription/renewal-review` accepts subscriptionId and revision;
`/cloud/account/subscription/undo` additionally requires expectedRenewalTermsDigest.
Hosts must display the complete renewal estimate and obtain explicit approval.
Undo calls the reviewed confirmation API, never legacy unreviewed undo. Its
idempotency identity includes approved terms and survives native restarts. A
same-terms retry requires a matching FAILED predecessor via retryOf; changed
terms require a fresh review and explicit confirmation. Recovery reads never
redispatch. Server-side pending exclusion and billing authority remain decisive.

Native account-factor transport exposes POST `/cloud/account/methods`,
`/methods/unlink`, `/methods/phone/start`, `/methods/phone/verify`, and
`/cloud/account/security/{status,start,verify,enroll/start,enroll/verify}` (method suffixes are relative to
`/cloud/account`). The composed Auth host owns input validation, recent MFA,
private session replacement, collision protection and cancellation. These routes
are unavailable to service-only hosts. They do not manage Gmail consent.


`createOrganizationSubscriptionUpgradeQuote` sends a current manager's catalog
intent to the organization upgrade review endpoint. The returned quote separates
due-now terms from a recurring estimate and expires after at most 60 seconds.
It does not authorize or execute a charge; the internal provider identities and
persistence digests are not part of the public DTO.

Use `confirmOrganizationSubscriptionUpgrade` with the saved `quoteId` and a stable
idempotency key, then `readOrganizationSubscriptionUpgrade` for durable status.
Repeated confirmation reconciles the original effect; status reads never dispatch.
An unknown outcome is pending, not permission to create another payment or quote.
These methods require a current organization billing-manager session.

`continueOrganizationSubscriptionUpgradePayment(commandId)` retrieves a fresh
original-invoice continuation or reconciled command status. Treat its URL as
private ephemeral payment UI data; never persist or log it. Call again after the
provider UI returns and use the durable command result to determine completion.

`createOrganizationSubscriptionDowngradeQuote` reviews a lower catalog plan at
the existing period end. The quote expires within 60 seconds and reports no
immediate charge plus a long-term recurring estimate. Saving it does not schedule
a downgrade; do not show the plan as changed or scheduled after this call.
