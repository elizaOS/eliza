# Eliza cloud

The cloud is the hosted service side of Eliza. It owns identity and
sessions, registered native clients and their device keys, plans, billing
and entitlements, and the paid services a device calls: metered inference,
batch and realtime speech, maps and managed Google. Agents run on the
owner's device; the cloud hosts no agent, app or sandbox and never runs a
turn. The device half of sign-in, credential custody and voice belongs to
os, and the agent calls the cloud only through [the client](./client.md).
An operator runs a deployment from the command line; there is no HTTP admin
route.

Spec values are milliseconds since the epoch and integer micro-USD
(1 USD = 1,000,000); character counts are UTF-16 code units. Wire encodings
differ only where a spec says so.

| Area | Specifications |
| --- | --- |
| Shared | [Vocabulary and refusals](./shared/types.md), [metering holds](./shared/metering.md), [provider change dispatched once](./shared/dispatchOnce.md), [rate limiter](./shared/rateLimit.md) |
| Deployment and operation | [Deployment profile](./deployment.md), [operator commands](./operator.md), [hosted return pages](./returnPages.md), [cloud client](./client.md) |
| Identity | [Accounts](./identity/accounts.md), [request authentication](./identity/requestAuth.md), [sessions](./identity/sessions.md), [code challenges](./identity/codeChallenges.md), [Google sign-in](./identity/federatedSignIn.md), [second factor](./identity/secondFactor.md), [sign-in methods](./identity/signInMethods.md), [account deletion](./identity/deletion.md) |
| Native clients | [Registered native clients](./nativeClients/registry.md), [device keys](./nativeClients/deviceKeys.md) |
| Billing | [Plan catalog](./billing/plans.md), [entitlements](./billing/entitlements.md), [funds](./billing/funds.md), [plan allowance](./billing/allowance.md), [subscriptions](./billing/subscriptions.md), [subscription checkout](./billing/checkout.md), [subscription commands](./billing/subscriptionCommands.md), [payment provider events](./billing/providerEvents.md), [grant codes](./billing/grantCodes.md) |
| Inference | [Chat models and prices](./services/models.md), [chat completions](./services/inference.md) |
| Speech | [Batch speech](./services/speech.md), [realtime speech session](./services/speechSession.md), [speech relay protocol](./services/speechRelay.md) |
| Maps | [Hosted maps](./services/maps.md) |
| Managed Google | [Connection](./services/google/connection.md), [Gmail reads](./services/google/mailRead.md), [reviewed Gmail changes](./services/google/mailOperations.md), [Calendar](./services/google/calendar.md) |

## Story: Use inference on my subscription or funded pilot account

> As a subscriber or funded pilot, I can send a request to the deployment's model.
> My account shows the subscription the billing provider currently recognizes.

### A request needs an active account and sufficient funding for its quote

The deployment uses the [shared hold](./shared/metering.md) to reserve the
quote before contacting a provider. A paid period supplies its remaining
[allowance](./billing/allowance.md) first. Other readable plans use the
account's [funded credits](./billing/funds.md). An `Idempotency-Key` UUID
or the request ID identifies the chat within its organization. A repeated key
returns `409 already_dispatched` without sending or charging another call. The chat
request is bounded to 256 KiB and a listed model and prompt are priced before
the hold is reserved. Model prices and reported token counts follow the
[model catalog](./services/models.md).

```quint
pure def mayDispatchFundedRequest(authenticated: bool, freshHold: bool, dispatchCommitted: bool): bool =
  authenticated and freshHold and dispatchCommitted
pure def lawPaidAccessRequiresIdentity(freshHold: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(false, freshHold, dispatched))
pure def lawDuplicateCannotSpendAgain(authenticated: bool, dispatched: bool): bool =
  not(mayDispatchFundedRequest(authenticated, false, dispatched))
```

### A streamed answer sends complete OpenAI frames and settles the same hold

The caller can see each complete data frame while the provider is still
working. Frames remain whole across upstream chunks, including split UTF-8
characters. The cloud bounds frame and response size. A finished answer ends
with one `[DONE]`, preceded by one reported usage chunk if the caller asked
for it. A definite provider rejection before the stream starts is an HTTP
refusal. A truncated or unreadable stream sends one error frame and then
`[DONE]`.
The original hold settles once at the billed cost when usable counts were
reported, including after a stream failure. It settles at the quote when no
usable report arrived. A caller disconnect releases the provider connection
and charges the greater of quoted and reported input tokens, plus the
output tokens estimated from delivered text. Between dispatch and the
provider's response headers, a disconnect charges only quoted input.

The [chat completion rules](./services/inference.md) define the framing,
chunking and charge decisions. The [shared metering rules](./shared/metering.md)
define the lifecycle of the original hold.

```quint
import inference as Chat from "./services/inference"
import metering as Holds from "./shared/metering"
import models as Models from "./services/models"
pure def lawInferenceStreamFraming(deltas: List[int], ending: Chat::StreamEnding, usageAsked: bool, usageReported: bool): bool =
  Chat::lawEveryUnbrokenStreamEndsInOneDone(deltas, ending, usageAsked, usageReported)
  and Chat::lawOnlyAFinishedStreamCompletes(deltas, ending, usageAsked, usageReported)
  and Chat::lawUsageIsSentOnceAndOnlyAsReported(deltas, ending, usageAsked, usageReported)
  and Chat::lawOnlyAFailedStreamSendsAnError(deltas, ending, usageAsked, usageReported)
pure def lawInferenceStreamChunking(first: List[int], second: List[int]): bool = Chat::lawChunkBoundariesDoNotChangeEvents(first, second)
pure def lawInferenceStreamReportDeterminesTheCharge(u: Models::ProviderUsage, quoted: Models::TokenCounts): bool =
  Chat::lawAProviderReportDeterminesTheCharge(u, quoted)
pure def lawInferenceStreamHangUpChargesDeliveredText(reportedInput: int, deliveredChars: int, quoted: Models::TokenCounts): bool =
  Chat::lawAHangUpPaysForWhatItGot(reportedInput, deliveredChars, quoted)
pure def lawInferenceStreamClosesTheOriginalHold(lane: Holds::FundingLane, quote: int, allowanceAvailable: int, creditAvailable: int,
  dispatched: bool, end: Chat::CompletionEnd, quoted: Models::TokenCounts, creditFree: int): bool =
  Chat::lawAMissingReportChargesTheQuote(dispatched, end, quoted)
  and Chat::lawEveryCallClosesItsHoldOnce(lane, quote, allowanceAvailable, creditAvailable, dispatched, end, quoted, creditFree)
```

## Story: Sign in to the Cloud

> As a person using a product’s Cloud, I can sign in with Google or a code
> sent to my email address or phone. I can end my session from the sign-in
> device. I can approve my Android app to use inference without giving it my
> browser session or giving the page a device key.

### Sign-in requires proof from the chosen provider

Google signs in the subject reached by redeeming the browser-bound OAuth code.
Email and SMS prove the destination and the browser that requested the code. SMS is available only for the deployment’s allowed calling codes and remaining send budget. The
deployment resolves the proof to a single account, preferring a known subject
and then the account that owns the proven email address. Accounts and sessions
belong to the deployment that issued them.

```quint
type CloudSignInProvider = CloudGoogle | CloudEmail | CloudSms
pure def canIssueCloudSession(requested: CloudSignInProvider, verified: CloudSignInProvider, deploymentMatches: bool, providerVerified: bool): bool =
  requested == verified and deploymentMatches and providerVerified
```

### A browser session ends when it expires or the person signs out

A signed-in person is identified by the account of their active session for
this deployment. The browser can rotate its 15-minute access token using its
30-day refresh family. Signing out retires that family.

```quint
pure def cloudSessionAllows(sessionEndsAt: int, nowAt: int, sessionPresent: bool): bool =
  sessionPresent and nowAt < sessionEndsAt
```

### A registered device grant authorizes device services

The person approves a short-lived grant for the registered Android client
and its verified return address while signed in. A browser that names the
account shown for approval receives a grant only while signed in to that
account. Only the device proving possession of the grant’s verifier can redeem it, once. The device
acknowledges receipt before it can use the key. The same exchange offers
the device's mail lease (`identity/sessions`), which the acknowledgement makes
live; only the native shell holds it. Signing out stops activation
of an unfinished grant. An active key continues to authorize inference and
consented speech until its deadline or its own revocation; the lease alone
renews it, and signing out ends both.
