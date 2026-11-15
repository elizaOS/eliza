# Agent host

The agent host runs one agent for one owner on a server, a desktop or the
device. It boots the [kernel](../core/) with an admitted plugin profile,
serves the owner's conversations and tasks over HTTP and the native
gateway, keeps the resident agent alive on the device, and stops cleanly.
Identity comes from [auth](../auth/), wire shapes from
[contracts](../contracts/), and hosted services from [cloud](../cloud/).
Each specification below is one area of the host; a product composes them
and supplies its own character, branding and configuration.

Host:

- [Boot and teardown](./host/boot.md)
- [Process signals and server resources](./host/process.md)
- [Configuration](./host/config.md)
- [Runtime operations](./host/operations.md)
- [Start, restart, stop and reset](./host/lifecycle.md)
- [Request budgets and logs](./host/requests.md)
- [Route access](./host/access.md)
- [Owner pairing](./host/ownerPairing.md)
- [Role bootstrap](./host/roles.md)
- [Retention sweeps](./host/retention.md)
- [Hooks and the memory watchdog](./host/hooks.md)
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
- [Choice cancellation](./actions/approvals.md)
- [Secrets and plugin activation](./actions/secrets.md)
- [Autonomy and the global pause](./actions/autonomy.md)
- [Background memory and the trajectory store](./actions/memory.md)

Conversation:

- [Chat](./conversation/chat.md)
- [Conversations](./conversation/conversations.md)
- [Turns](./conversation/turns.md)
- [Events](./conversation/events.md)
- [Chat gateway](./conversation/chatGateway.md)
- [Conversation ownership](./conversation/ownership.md)

Client:

- [Runtime client](./client/)
  - [Runtime client transport](./client/runtimeClient.md)
  - [Client conversation](./client/conversation.md)
  - [Reply streaming](./client/replyStreaming.md)
  - [Task lifecycle](./client/taskLifecycle.md)
  - [Observation support](./client/observationSupport.md)
  - [Status cache](./client/statusCache.md)
  - [Conversation load](./client/conversationLoad.md)

Views:

- [Views](./views/views.md)
- [Native views](./views/nativeViews.md)

Device actions:

- [Device actions](./deviceActions/)
  - [Capabilities](./deviceActions/capabilities.md)
  - [Attempts](./deviceActions/attempts.md)
  - [Execution](./deviceActions/execution.md)
  - [Executor refusal](./deviceActions/executorRefusal.md)
  - [Review](./deviceActions/review.md)
  - [Read completion](./deviceActions/readCompletion.md)
  - [Read completion answers](./deviceActions/readCompletionAnswer.md)
  - [Camera](./deviceActions/camera.md)
  - [Photos](./deviceActions/photos.md)
  - [Clock](./deviceActions/clock.md)
  - [Reminder journal](./deviceActions/reminderJournal.md)
  - [Telephony review](./deviceActions/telephonyReview.md)

Tasks:

- [Interactive tasks](./tasks/)
  - [Choices](./tasks/choices.md)
  - [Task routes](./tasks/http.md)
  - [Owner fence](./tasks/ownerFence.md)
  - [Storage custody](./tasks/storageCustody.md)
  - [Encrypted writer lease](./tasks/encryptedWriterLease.md)
  - [Storage migration](./tasks/storageMigration.md)
  - [Record recovery](./tasks/recordRecovery.md)
  - [Website goals](./tasks/websiteGoal.md)
  - [Interaction sessions](./tasks/interactionSessions.md)

Native host:

- [Gateway](./nativeHost/gateway.md)
- [Surface channel](./nativeHost/surfaceChannel.md)
- [Evidence](./nativeHost/evidence.md)
- [Refusals](./nativeHost/refusals.md)
- [Diagnostics journal](./nativeHost/diagnosticsJournal.md)
- [Public fetch](./nativeHost/publicFetch.md)
- [Runtime supervisor](./nativeHost/runtimeSupervisor.md)
- [Account migration](./nativeHost/accountMigration.md)
- [Trace queue](./nativeHost/traceQueue.md)

Resident agent:

- [Resident agent](./resident/)
  - [Startup](./resident/startup.md)
  - [Adoption](./resident/adoption.md)
  - [Request authority](./resident/requestAuthority.md)
  - [Install identity](./resident/installIdentity.md)
  - [Watchdog](./resident/watchdog.md)
  - [Provider rebind](./resident/providerRebind.md)
  - [Bundle inventory](./resident/bundleInventory.md)

Services:

- [Triggers](./triggers.md)
- [Scheduled tasks](./scheduledTasks.md)
- [Notifications](./notifications.md)
- [Permissions](./permissions.md)
- [Documents](./documents.md)
- [Media](./media.md)
- [Connectors](./connectors.md)
- [Trajectories](./trajectories.md)

Storage:

- [SQL store](./storage/sql.md)
- [Device database](./storage/pglite.md)
