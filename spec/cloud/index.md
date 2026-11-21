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
