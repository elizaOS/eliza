# @elizaos/cloud-api

The Eliza Cloud HTTP API: a Cloudflare Workers app (Hono router) that backs auth,
app/agent registration, inference routing, billing, MCP, A2A, domains, and container
deploys.

Runs on Cloudflare Workers with Hono. Start with `bun run --cwd packages/cloud/api dev`;
local bindings are derived from root .env/.env.local. Add routes in the file-based route
tree and run the package codegen script. The build script checks types; typecheck also
validates router and Worker bundling contracts.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/api build  # build
bun run --cwd packages/cloud/api test   # tests
```

## Independent native App Auth clients

`ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` optionally registers additional native clients.
It is a server-owned JSON array of `{clientId, appId, redirectUri, enabled}` records.
Client IDs, app UUIDs and canonical HTTPS return URLs must be unique, including
against the existing `ai.elizaos.app` registration. Unknown and disabled clients
fail closed; malformed additional configuration does not change the legacy client.
The global mobile-auth enable switch and environment binding still apply.

Before enabling a client, provision its own active, approved app with an active
owner/organization, an exact allowed callback, and no live generated application
API key. Use separate registrations in staging and production. Validate the public
`/api/v1/app-auth/mobile/config` response for that client/environment/return URL
before shipping. The app UUID and server secrets must not be included in the
native configuration. Retain the existing S256 grant, inactive exchange, durable
receipt acknowledgment, self-revocation and account recovery contracts. `cloud:user`
is the existing broad user/organization capability, not a narrower permission claim.

## Organization renewal review

`GET /api/v1/subscriptions/cancel/undo/review` accepts `subscriptionId` and a
positive decimal `expectedSubscriptionRevision`. It requires the current billing
manager session and returns a no-store, 60-second renewal estimate for an eligible
scheduled cancellation. The pinned provider invoice preview includes tax, discounts
and customer balance; unsupported or incomplete previews fail closed. It creates
no command, invoice or payment. `termsDigest` compares reviewed terms; it is not an
authorization token or price lock. Use the confirmation route below to persist and revalidate reviewed terms
before a reversal dispatch.

`POST /api/v1/subscriptions/cancel/undo/confirm` requires the subscription ID,
expected lifecycle revision, idempotency key and `expectedRenewalTermsDigest`
from the review. It persists fresh matching terms with the durable command and
revalidates them before dispatch. Reusing the same intent reads its recorded
outcome; it never dispatches again. Changed terms before admission return 409;
a rejection with a still-ready lease becomes FAILED, while a started dispatch
retains OUTCOME_UNKNOWN until observation resolves it. Recovery fails expired
prepared reviews without reconstructing a mutation. The existing undo/status
APIs remain compatible; consumers needing reviewed confirmation use this route.
Apply migration `0510_subscription_renewal_review_receipts` before deploying.


## Organization upgrade review

`POST /api/v1/subscriptions/upgrade/review` accepts `subscriptionId`, a positive
safe-integer `expectedSubscriptionRevision`, and a catalog `targetPlanKey`.
The current billing manager session is required and revalidated after provider
reads. The no-store response contains `quoteId` and `review`, separating due-now
proration/tax/discount/customer-balance terms from a long-term recurring estimate.
The exact reviewed timestamp and prorated additional allowance are retained.
Apply organization-upgrade migrations 0511 through 0520 before deployment.
Saving a quote creates no charge, command or allowance grant. Confirmation and
payment continuation use the separate endpoints below; scheduled downgrade remains
separate lifecycle work.

`POST /api/v1/subscriptions/upgrade/confirm` accepts only `quoteId` and
`idempotencyKey`. It revalidates the current manager and original review before
one dispatch; retries retain the original command. `GET /api/v1/subscriptions/upgrade/:commandId`
reads durable status without provider work. Both return no-store responses and
require a current billing-manager session. `OUTCOME_UNKNOWN` can include pending
payment and must not trigger a new intent. `failure: review_required` means an
unstarted review ended; `invoice_void` requires definitive original void evidence.
Product UI/native adoption and real provider acceptance remain separate work.

`POST /api/v1/subscriptions/upgrade/:commandId/payment` reconciles the original
command and returns either durable status or an ephemeral private hosted-invoice
continuation. It checks the original invoice, reviewed amount, pending target and
unpaid payment intent, then revalidates manager/source/session authority. It never
creates or pays an invoice. The no-store URL must stay out of logs, model context
and history. Call again after browser return; return alone does not prove payment.

`POST /api/v1/subscriptions/downgrade/review` uses the same authenticated catalog
intent and returns an immutable lower-plan quote. `effectiveAt` is the current
period end and `amountDueNowCents` is zero. `recurringEstimate` is a long-term
estimate, not a guaranteed next invoice. This endpoint creates no provider
schedule, command, charge or allowance change; downgrade confirmation is not
yet exposed. Upgrade confirmation rejects a downgrade quote.
