# Agent host

The agent host runs one agent for one owner on a server, a desktop or the
device. It boots the [kernel](../core/) with an admitted plugin profile,
serves the owner's conversations and tasks over HTTP and the native
gateway, keeps the resident agent alive on the device, and stops cleanly.
Identity comes from [auth](../auth/), wire shapes from
[contracts](../contracts/), and hosted services from [cloud](../cloud/).
Each specification below is one area of the host; a product composes them
and supplies its own character, branding and configuration.

A consumer build composes the host from these modules, and each has its
rules here:

- the resident agent service an Android host app installs, with its
  provider slot, credential shutdown lease, route gate and attach decision:
  [the Android host](./resident/host.md) and the
  [resident lifecycle](./resident/lifecycle.md);
- the runtime profile that binds an on-device agent's inference to the
  owner's cloud account, and a consumer's plugin policy:
  [plugin profile](./plugins/profile.md);
- the in-memory session of the owner's own provider keys:
  [resident credential](./resident/credential.md);
- the character a provisioned or local deployment boots as, its routing id
  and who connects its connectors: [character](./host/character.md);
- the private runtime a desktop native host launches for its account:
  [runtime supervisor](./nativeHost/runtimeSupervisor.md), with its private
  files and environment in [configuration](./host/config.md);
- the launch policy a host hands the agent, its native views, browser
  commands and time zone: [configuration](./host/config.md);
- the owner's managed Google services, which a host reaches through the
  cloud: [managed Google connection](../cloud/managedGoogle/connection.md);
- the device as a target a controller pairs with through the cloud:
  [cloud remote pairing](../cloud/remotePairing.md).

A consumer's screens, its user interface components and its test harness
are its own and are not specified here.

Host:

- [Boot and teardown](./host/boot.md)
- [Process signals and server resources](./host/process.md)
- [Configuration](./host/config.md)
- [Runtime operations](./host/operations.md)
- [Runtime-management proposals](./host/proposals.md)
- [Start, restart, stop and reset](./host/lifecycle.md)
- [Request budgets and logs](./host/requests.md)
- [Route access](./host/access.md)
- [Owner pairing](./host/ownerPairing.md)
- [Role bootstrap](./host/roles.md)
- [Retention sweeps](./host/retention.md)
- [Event hooks](./host/eventHooks.md)
- [Memory watchdog](./host/memoryWatchdog.md)
- [Tool-call cache](./host/toolCache.md)
- [Security audit](./host/audit.md)
- [Escalation](./host/escalation.md)
- [Proactive messages](./host/proactive.md)
- [Status and readiness](./host/status.md)
- [First run](./host/firstRun.md)
- [Character](./host/character.md)
- [Model selection](./host/models.md)

Plugins:

- [Plugin profile](./plugins/profile.md)
- [Model providers](./plugins/modelProviders.md)

Core actions:

- [Reply, ignore and choose](./actions/core.md)
- [Choice cancellation](./actions/choiceCancellation.md)
- [Approvals are never given by voice](./actions/voiceApproval.md)
- [Secrets and plugin activation](./actions/secrets.md)
- [Autonomy](./actions/autonomy.md)
- [Background memory](./actions/memory.md)

Conversation:

- [Chat](./conversation/chat.md)
- [Conversations](./conversation/conversations.md)
- [Turns](./conversation/turns.md)
- [Events](./conversation/events.md)
- [Chat gateway](./conversation/chatGateway.md)
- [Conversation ownership](./conversation/ownership.md)

Client:

- [Runtime client](./client/)

Views:

- [Views](./views/views.md)
- [Native views](./views/nativeViews.md)

Device actions:

- [Device actions](./deviceActions/)

Tasks:

- [Interactive tasks](./tasks/)

Native host:

- [Gateway](./nativeHost/gateway.md)
- [Page command channel](./nativeHost/surfaceChannel.md)
- [Evidence](./nativeHost/evidence.md)
- [Refusals](./nativeHost/refusals.md)
- [Diagnostics journal](./nativeHost/diagnosticsJournal.md)
- [Public page fetch](./nativeHost/publicFetch.md)
- [Runtime supervisor](./nativeHost/runtimeSupervisor.md)
- [Account migration](./nativeHost/accountMigration.md)
- [Trace queue](./nativeHost/traceQueue.md)

Resident agent:

- [Resident agent](./resident/)

Services:

- [Triggers](./triggers.md)
- [Scheduled tasks and the global pause](./scheduledTasks.md)
- [Notifications](./notifications.md)
- [Permissions](./permissions.md)
- [Documents](./documents.md)
- [Media](./media.md)
- [Connectors](./connectors.md)
- [Trajectories and the trajectory store](./trajectories.md)

Storage:

- [SQL store](./storage/sql.md)
- [Device database](./storage/pglite.md)
