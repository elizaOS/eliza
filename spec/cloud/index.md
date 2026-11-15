# Hosted services

`@elizaos/cloud` is the hosted half of Eliza: accounts and organizations,
native-client sign-in, credits and subscriptions, hosted agents, inference,
speech, maps, managed Google and the client an agent uses to reach them. Each
child spec owns one area and its state machine.

Eliza ships no branded cloud. A branded deployment imports this package and
the [auth package](../auth/) and supplies its own configuration: its origins,
tenant, registered native clients, payment catalog and enabled capabilities,
as the [deployment profile](./deployment.md) requires. No product is named
here; what a consumer needs is stated as a capability of the area that owns
it.

| Area | Specifications |
| --- | --- |
| Accounts and billing | [Deployment profile](./deployment.md), [accounts and deletion](./accounts.md), [registered native clients](./nativeClients.md), [command-line login](./cliLogin.md), [remote agent pairing](./remotePairing.md), [credits](./credits.md), [subscriptions](./subscriptions.md), [entitlements and plan limits](./entitlements.md), [host operations](./hostOperations.md), [cache and circuit infrastructure](./infrastructure.md), [hosted auth service](./authService.md) |
| Runtime services | [Inference](./inference.md), [agent hosting](./agentHosting.md), [shared runtime](./sharedRuntime.md), [hosted backups](./backups.md), [background jobs](./jobs.md), [provider connections](./connections.md), [speech](./speech.md), [maps](./maps.md), [object storage](./storage.md), [document execution](./documentExecution.md), [cloud client](./client.md) |
| Managed Google | [Connection](./managedGoogle/connection.md), [Gmail](./managedGoogle/gmail.md), [calendar reads](./managedGoogle/calendarRead.md), [calendar sync](./managedGoogle/calendarSync.md) |

Cloud-hosted user applications are not part of Eliza and are not modeled:
the app registry and its routes, app containers and frontends, app
deployment, custom domains with their purchase and health rotation, app
ingress and hosted frontends, app credits and app billing commands, and app
delegation of sign-in. Only a registered native client's Google delegation
remains, in [registered native clients](./nativeClients.md), and that
registry depends on no app record.

These develop features are dropped with no replacement: legacy checkout
settlement and legacy payment-provider adoption, the speech host cutover,
the in-process database protocol ownership, advertising refunds, press
submission, on-chain sweeps and the crypto-sweep phase of account deletion,
agent-to-agent task storage, hosted tool-server argument admission and
discovery, generation object versions, video settlement, the hosted vertex
job observer and GPU worker supervisor, trajectory object retention, the
anonymous chat gate, the hosted onboarding product, the community welcome
queue, held webhook retries, cloud action-review suggestions,
trusted-execution attestation, personal shared consent, and web-push and
device-bus notifications.
