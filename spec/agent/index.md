# On-device agent

The agent packages run one owner's agent on the owner's device: one Node
process, started by the device host from a [launch](./host/launch.md), with
one PGlite store, one bound model backend and a local API reached over a
private Unix socket or loopback HTTP. They also ship the libraries a screen
uses to talk to that agent. Each package exports its code from one root
entry. `@elizaos/agent` is the browser-safe half: the client and voice
libraries, the launch decoders, the route gate, the turn context and the
device-operation decoders. `@elizaos/agent-host` is the Node half: the
process, its storage and model binding, the modules below, the bundle builder
and the process entry a bundle starts. The host imports the browser-safe
half, never the reverse. The device-action routes (enrollment, proposal
review and read completion) are always served and are not a module a load
list names. Optional modules (approvals, notifications, views, the device
proposal action, reply draft, triggers, scheduled tasks, interactive tasks and
the page command channel)
load only when the launch's [plugin plan](./plugins/profile.md) names them.

The packages do not own the kernel: identity, model dispatch,
authorization, sessions, scheduling and receipts are [core](../core/index.md)'s.
The device side (agent service, native bridge, keystore, native audio,
executors and review screens) is os's, and os imports agent specs; no agent
spec imports an os spec. Accounts, billing, metered inference, speech and
managed Google are cloud's, which the agent reaches through its cloud link.
The cloud runs no agent. No spec here names a product.

| Area | Specifications |
| --- | --- |
| Host | [Launch contract](./host/launch.md): launch document, frame and exit codes; [agent process](./host/process.md): boot, health, status and stop; [resources](./host/resources.md): each resource released once, in reverse order |
| Access | [Local access](./access/auth.md): only the supervising host's token grants anything; [route gate](./access/routes.md): the product's route list and admission; [local request exchange](./access/transport.md): socket and loopback framing |
| Storage and models | [Device database](./storage/database.md): open, lock, migrate, retention; [model binding](./models/binding.md): backend, account state and cloud link |
| Plugins and bundle | [Plugin plan](./plugins/profile.md): load list, order and product plugin; [agent bundle](./plugins/bundle.md): `agent.mjs`, snapshot and manifest |
| Conversation | [Conversations](./conversation/conversations.md): create, list and read; [turns](./conversation/turns.md): one message in, one reply out; [reply stream](./conversation/replyStream.md): streamed reply frames; [turn context](./conversation/turnContext.md): screen observation and voice UI metadata; [turn planning](./conversation/planning.md): actions as tools, honest outcomes, cues, cards and turn evaluators; [event feeds](./conversation/events.md): live event subscriptions |
| Device actions | [Device requests](./deviceActions/index.md): offer to settled outcome and enrollment; [capabilities](./deviceActions/capabilities.md): negotiated capability vocabulary; [operations](./deviceActions/operations.md): the closed operation set; [device execution](./deviceActions/execution.md): the device's journal and executor; [reply draft](./deviceActions/replyDraft.md): draft a message reply |
| Owner modules | [Approvals](./approvals.md): the approval queue; [notifications](./notifications.md): notice list and read mark; [views](./views.md): view navigation and interaction; [page command channel](./surfaceChannel.md): commands to the browser surface |
| Schedule | [Scheduled tasks](./schedule/scheduledTasks.md): reminders, check-ins and their verbs; [prompt triggers](./schedule/triggers.md): saved prompts on a schedule or event |
| Interactive tasks | [Task host](./tasks/index.md): custody around core's interactive task; [task store](./tasks/store.md): sealed records on the device; [task wire](./tasks/wire.md): routes, codes and presentation |
| Client | [Runtime client](./client/runtimeClient.md): a screen's request client; [client turns](./client/turns.md): the chat turn controller |
| Voice | [Voice session](./voice/session.md): listen, endpoint, reply and barge-in; [client audio](./voice/clientAudio.md): capture, encoding and playback helpers |
