# @elizaos/cloud-sdk

TypeScript SDK for Eliza Cloud API access, CLI login, API-key auth, agent management, model APIs, containers, billing credits, and generic endpoint calls.

For independently subscribed apps using free shared identity and explicit Google capabilities, see [registered app delegation](app-delegation.md).

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});

const models = await cloud.listModels();
const credits = await cloud.getCreditsBalance();
const agents = await cloud.listAgents();

// Curated public Cloud API routes are also exposed through cloud.routes.
const app = await cloud.routes.getApiV1AppsById({
  pathParams: { id: "app_123" },
});
const stream = await cloud.routes.postApiV1ChatCompletionsRaw({
  json: { model: "gpt-4o-mini", messages: [], stream: true },
});
```

## Native product selection

`getApplicationBillingProduct(slotKey)` resolves an operator-configured native
product for the deployment's billing environment. It requires a free signed-in
session and returns the app ID, name and product family before a purchaser
account exists. It never starts a trial, charges a customer or changes credits.
Use the same slot key as `nativeApplicationSlot` for inference. An unavailable
or disabled slot is an explicit error; do not select a different billing source.

## Independent app subscriptions

`cloud.appBilling(appId)` scopes catalog, customer accounts, subscriptions,
checkout, portal, seats, invoices, and usage to one registered application.
Its purchaser can use a free Cloud identity. Purchasing this app does not
purchase the Eliza app, and app subscription revenue does not replenish a
purchaser's infrastructure credits. The developer remains the infrastructure
payer for app operations.

```ts
const billing = cloud.appBilling(registeredAppId);
const { data: catalog } = await billing.getCatalog();
const { data: account } = await billing.resolveAccount({
  externalReference: workspaceId,
  displayName: workspaceName,
});
const { data: operation } = await billing.startTrial(account.id, productFamilyKey, {
  planRevisionId: selectedPlan.id,
  quantity: editingSeatCount,
  idempotencyKey: persistedAttemptId,
  expectedSubscriptionRevision: null,
});
```

The backend must authenticate the registered application and the verified
acting purchaser; `externalReference` never grants account membership by
itself. Map app roles to billing administrators or read-only members. Prices,
trial eligibility, seat bounds, merchant ownership, and return destinations
are server-owned. Every eligible app trial lasts seven days without requiring
a payment method. A plan switch preserves the original trial end and allowance.

For a hosted billing page, use `cloud.appBilling(appId, { clientId })` with the
registered client ID. Cloud derives the mode for every catalog, account,
subscription, operation, and record request from that active registration.
The reference grants no purchaser permissions: session membership and browser
mutation checks still apply. A delegated backend may select only its own client.

`listAdministrators(accountId)` returns the current environment's administrator
IDs and shared membership revision. A purchaser with current administrator
authority can call `changeAdministrator(accountId, { action, userId,
expectedRevision, idempotencyKey })`. Actions are `grant`, `revoke`, and `transfer`;
transfer grants an active accepted member and demotes the acting purchaser to an
ordinary member atomically. Grant/revoke affect only administrator authority;
seats and membership remain intact. At least one active, non-anonymous Cloud
administrator must remain. Plain app backend credentials cannot use this mutation;
it requires a signed purchaser session or purchaser delegation with `billing:write`.

Administrator changes share the backend membership revision. Persist the exact
request before sending; a completed transfer's original actor can recover its
receipt while still an active ordinary member. Never replace a saved request on
an ambiguous authorization or network failure. Only
`APP_BILLING_MEMBERSHIP_REVISION_CONFLICT` proves the submitted revision was not
applied and permits a refresh and newly reviewed request. Transfers leave the
other billing environment, subscription, seats, and original trial eligibility
unchanged. App backends may subsequently remove the former administrator's
ordinary membership, but cannot remove the successor's administrator grant.

For backend membership synchronization, HTTP 409 with
`APP_BILLING_MEMBERSHIP_REVISION_CONFLICT` means no receipt exists for that
operation and its membership changes were not applied. Read current membership
and revise the saved intent before retrying. This code is emitted only after
receipt lookup; a completed operation still returns its original receipt even
when its expected revision is now stale. Keep the identical saved body for all
other conflicts and uncertain outcomes; a generic 409 does not authorize
replacing an intent.

Persist the idempotency key before a mutation and reuse it with the identical
request after a timeout. `pending` and `outcome_unknown` are unresolved states.
An operation's `requires_action` URL opens provider-hosted payment or account
management; returning from that page does not establish paid access. Read the
authoritative subscription snapshot. A failed read is an unavailable state;
only a successful snapshot can report an absent subscription.

For purchaser mutations, only HTTP 409 with `APP_BILLING_COMMAND_NOT_APPLIED`
confirms that no command existed for this intent and command preparation rolled
back before dispatch. Refresh the subscription and obtain new review/consent
before replacing that saved intent. Other 4xx responses can follow a lost
successful response and must retain the original body and idempotency key.
An operation ID always remains the recovery handle until a terminal operation
result; do not discard it based on an HTTP status alone.

A confirmed paid update can return `requires_action` with `action.kind` set to
`payment`. Open that operation's hosted invoice URL and poll the same operation;
do not submit another update or expire it as a checkout. The previous plan and
seat capacity remain authoritative until captured payment and the subscription
change are reconciled. A confirmed void invoice can terminate the operation with
`APP_BILLING_PAYMENT_EXPIRED`; refresh the snapshot and review a new quote before
starting another purchase. The link's expiry alone never proves payment failure.

For an existing paid subscription, call `quoteSubscriptionUpdate`, display its
exact amounts and trial terms, then submit `updateSubscription` with the quote
ID after explicit confirmation. A stale quote or revision must be refreshed.
An open checkout must be expired through its durable operation before changing
that purchase intent. Seat assignments consume existing purchased capacity;
assigning a member does not purchase more seats.

`assignSeat` takes the canonical Cloud user ID of a current account member;
pending email invitations remain in your app. New assignments require current
subscription capacity and wait while a subscription change is pending. An
administrator can revoke seats after access expires. Save the exact request and
idempotency key before sending either mutation, then reload seats after a retry;
the receipt acknowledges the original operation even if that seat was later
revoked or replaced.

`listSeats`, `listInvoices`, and `listUsage` return `items` and `nextCursor`.
Request subsequent pages until the cursor is null; an invoice page can be empty
while a later historical subscription still has records. Keep cursors within
their original app, account, family, environment, and record type. Invoice
history remains available after cancellation. Usage contains settled app
allowance amounts, excluding pending reservations and developer infrastructure
charges. HTTP failures must remain visible as unavailable records.

`@elizaos/cloud-sdk/app-billing` exports the browser-safe DTOs and scoped client.
`@elizaos/cloud-sdk/app-notifications` verifies Cloud callbacks using their raw
body, `X-Eliza-Timestamp`, and `X-Eliza-Signature`. Supply the expected app ID
and its private signing key. Persist the verified event ID with processing to
deduplicate delivery, and retrieve the current subscription; notifications
carry revision hints, not entitlement grants. Access expires at the snapshot's
`validUntil` even if notification delivery is delayed.

## Existing app-credit integrations

A third-party web app can let users sign in with their Eliza Cloud account — no
API key pasting — and bill inference to a registered app's credits (the app
owner earns the configured markup). The client exposes the whole flow:

```ts
const cloud = new ElizaCloudClient(); // no key needed to start the login

// 1. Start a login session and open the hosted login (a tab works well).
const { sessionId, browserUrl } = await cloud.startCliLogin();
window.open(browserUrl, "_blank");

// 2. Poll until the user authorizes (handles the deadline/interval/terminal
//    states for you; throws on expiry/error/timeout).
const { apiKey, userId } = await cloud.waitForCliLogin(sessionId);
cloud.setApiKey(apiKey!);

// 3. Show/buy app-credits for your registered app.
const balance = await cloud.getAppCreditsBalance("app_123");
const checkout = await cloud.createAppCreditsCheckout({
  app_id: "app_123",
  amount: 5,
  success_url: location.origin,
  cancel_url: location.origin,
});

// 4. Run inference billed to the app's credits via the `appId` option
//    (sends the `X-App-Id` header). Omit `appId` to bill the caller's own credits.
//    Add `affiliateCode` to attribute the call to an affiliate for revenue share
//    (sends `X-Affiliate-Code`; read by the credit-billed inference routes).
const reply = await cloud.createChatCompletion(
  { model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
  { appId: "app_123", affiliateCode: "aff_xyz" },
);
```

For a third-party OAuth-style app sign-in, send the user to the canonical
Eliza Cloud app authorization route. Use the SDK helper so your app does not
accidentally link to bare `/authorize`, which is not a Cloud app-auth route:

```ts
import { buildAppAuthorizeUrl } from "@elizaos/cloud-sdk";

const authorizeUrl = buildAppAuthorizeUrl({
  appId: "app_123",
  redirectUri: "https://example.app/auth/eliza/callback",
  state: crypto.randomUUID(),
});

window.location.assign(authorizeUrl);
```

The generated URL is
`https://eliza.app/app-auth/authorize?app_id=...&redirect_uri=...&state=...`.
Use `/app-auth/authorize`; do not use `/authorize`.

`waitForCliLogin(sessionId, { timeoutMs?, intervalMs?, signal? })` and the
`{ appId, affiliateCode }` options on `createChatCompletion` / `createResponse` /
`createEmbeddings` / `generateImage` / `transcribeAudio` exist so browser apps
don't have to hand-roll the polling loop or a raw `fetch` to send `X-App-Id` /
`X-Affiliate-Code`. `appId` bills the app and credits the creator markup;
`affiliateCode` credits the affiliate's revenue share. Both are per-call and
sent only when set.

> Browser note: `startCliLogin` / `pollCliLogin` are CORS-friendly (token auth,
> no cookies). `pairWithToken` is server/agent-only — it sets an `Origin` header
> that browsers forbid `fetch` from overriding.

`cloud.routes` is generated from the public Cloud API route tree under
`apps/api`, including both Next-style exported HTTP handlers and Hono
`app.get` / `app.post` / `app.all` route modules. It intentionally excludes
admin, cron, webhook, internal, dashboard, auth, and MCP transport routes from
the package root SDK surface. The route audit still inventories the full route
tree so stale generated wrappers fail before publish.

JSON endpoints expose a typed method plus a `Raw` variant. Always-stream,
binary, and text routes return `Response` from the primary generated method;
mixed routes such as chat completions keep the JSON method and use `Raw` when
the request asks for streaming.

Parsed `request()` calls require an explicit JSON media type
(`application/json` or a structured `+json` type) and preserve every JSON
value, including primitives and `null`. Successful text, missing media types,
malformed JSON, and unexpectedly empty data responses throw `CloudApiError`;
use `requestRaw()` for text or binary bodies. `HEAD`, `204`, and `205`
responses are the deliberate bodyless exceptions and resolve to `undefined`.
The generic `get`, `post`, `put`, `patch`, `delete`, and
`postUnauthenticated` helpers preserve this behavior. Use `requestData` when
a caller requires JSON data even on a successful status.
Generated endpoints that deliberately return either JSON or `204` expose the
same `T | undefined` result, while data-required helpers reject a bodyless
response instead of hiding it behind their DTO type.
Older SDK releases could replace successful text or empty bodies with an
invented `{ success: true }` object; callers relying on that fallback must use
an explicit bodyless status or return a JSON response instead.

`pollJob` and `waitForCliLogin` enforce a total timeout through every request,
response-body read, and polling interval. Their timeout and interval options
accept integers from 0 through 2,147,483,647 milliseconds; zero timeout expires
immediately. Login cancellation also interrupts an in-flight request or wait.
Direct `getJob` and `pollCliLogin` calls accept optional `timeoutMs` and `signal`.

Refresh and verify route coverage after adding or changing API routes:

```bash
node packages/cloud/sdk/scripts/generate-public-routes.mjs
node packages/cloud/sdk/scripts/audit-api-routes.mjs
```

Run live e2e tests against the real API with:

```bash
ELIZA_CLOUD_SDK_LIVE=1 ELIZAOS_CLOUD_API_KEY=eliza_... bun run test:e2e
```

The live suite is intentionally split by capability:

- `ELIZA_CLOUD_SDK_LIVE=1` runs public real-API checks for CLI login bootstrap and model listing.
- `ELIZAOS_CLOUD_API_KEY` or `ELIZA_CLOUD_API_KEY` enables authenticated read checks.
- `ELIZA_CLOUD_SESSION_TOKEN` enables browser-session-only API key management checks.
- `ELIZA_CLOUD_SDK_LIVE_GENERATION=1` enables paid generation checks.
- `ELIZA_CLOUD_SDK_LIVE_RELAY=1` enables gateway relay lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_DESTRUCTIVE=1` must be combined with the specific resource flag before tests create or mutate resources.
- `ELIZA_CLOUD_SDK_LIVE_CONTAINERS=1` and `ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI=...` enable container lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_AGENT=1` enables Eliza agent lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_PROFILE_WRITE=1`, `ELIZA_CLOUD_SDK_PROFILE_FIELD=...`, and `ELIZA_CLOUD_SDK_PROFILE_VALUE=...` enable profile write checks.
- `ELIZA_CLOUD_SDK_LIVE_OPENAPI=1` forces the OpenAPI check when testing an environment where `/api/openapi.json` is public. The hosted production endpoint currently requires auth.

Build and publish:

```bash
bun run build
npm publish --access public
```

## Parsed responses

`request` and typed endpoint methods accept `application/json` and application
media types ending in `+json`, preserving objects, arrays and JSON primitives.
Successful HTML/text, malformed JSON and unexpectedly empty JSON responses
throw `CloudApiError`; they never become an invented `{ success: true }` DTO.
HEAD and HTTP 204/205 responses resolve to `undefined`, as these protocols have
no response body. Use `requestRaw` (or a generated `Raw` method) for text,
binary, streaming, or status-sensitive responses.

`pollJob` and `waitForCliLogin` enforce a total timeout through every request,
response-body read and polling interval. Their timeout and interval options
accept integers from 0 through 2,147,483,647 milliseconds; zero timeout expires
immediately. Login cancellation also interrupts an in-flight request or wait.
Direct `getJob` and `pollCliLogin` calls accept optional `timeoutMs` and `signal`.

App-customer inference with separate developer funding is documented in [app-inference.md](./app-inference.md).

### App-owner merchant and plan administration

`AppBillingAdminClient(cloud.v1, appId)` from
`@elizaos/cloud-sdk/app-billing-admin` uses a current owner or administrator
session to register merchants, review capability status, and create, verify,
publish or retire immutable plan revisions. Select a persisted client
registration; its environment determines test or live billing. A request header
cannot change the environment. New catalog prices currently use USD minor units.

A submitted plan is retained in its durable administration command until Stripe
returns verified product and price handles. The overview exposes pending
operations separately from verified plan rows. Keep the idempotency key and
complete request across retries, and call `recoverOperation` to recover provider
results after a timeout. Every plan grants an eligible seven-day trial without a
payment method. Publication verifies the current app approval, merchant
capabilities and actual provider price again.

Merchant verification can be unavailable before onboarding; nullable capability
and requirements fields express that state. Disabling a merchant stops new
sales while historical subscriptions continue billing and remain cancelable.
Retiring a plan preserves its provider bindings for existing subscribers.

Use `paidPeriods(clientRegistrationId, cursor)` to browse the app's settled
payment receipts. Pass `nextCursor` when the owner requests another page.
`previewRefund({ clientRegistrationId, paidPeriodId })` retrieves the original
payment and its current refundable amount from Stripe. It does not issue a
refund; another refund can change the remaining funds before submission.

`refund` selects a persisted `paidPeriodId` and an `amountCents`, with
`accessPolicy: "preserve"` and
`confirmation: "refund_original_payment_preserve_access"`. Cloud resolves the
original merchant, invoice, customer and historical price from that receipt.
The refund leaves the subscription and its renewal schedule in place and does
not replenish Cloud credits or consumed allowance. Cancel a subscription through
its separate cancellation workflow when that is also intended.

Keep the complete refund request and its idempotency key across a timeout.
`recoverOperation` discovers the original provider refund, including after the
provider retry window expires; absence outside that window remains
`outcome_unknown`. A `refund` result identifies the durable receipt, while
`receipt.providerStatus` distinguishes pending, successful, failed, canceled,
action-required and unavailable provider states. Poll the same operation to
refresh that status. Never create a new refund automatically because its
existing receipt is pending or failed.

`APP_BILLING_UI_ORIGIN` is the server-owned origin for checkout, portal and
onboarding returns; app Google callback URLs and browser Origin are not payment
redirect authority.
App subscription webhook setup and receiver verification are documented in [App subscription notifications](./app-notifications.md).

App client registration accepts `billingReturnUrl`: an exact HTTPS destination
on the app's allowed origins. Query strings and fragments are preserved, so an
app can return to a route such as `https://example.app/#/settings`. This field
is separate from OAuth `redirectUris`. Omitting it or passing `null` preserves
the Cloud billing page. Checkout and portal automatically use the destination
from their app, client, and billing environment; callers do not supply a return
URL to those endpoints. The resolved destination is persisted before provider
I/O, and recovering the same command retains it after registration changes.
