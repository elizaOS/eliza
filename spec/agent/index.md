# On-device agent

The Node process that runs one owner's agent on the device, its local API,
and the libraries that screens use. The package ships the host,
the local route definitions, the runtime JSON client and the device
bundle builder.

### Pending host modules

The [interactive task host](tasks/index.md) still needs an agent-owned
durable store, actuator and wire implementation before the package can
provide `@elizaos/agent/tasks`. The [voice client](voice/clientAudio.md)
still needs the session, capture, transcription and playback modules before
the package can provide `@elizaos/agent/voice`. The host's conversation
routes serve Grace's device turn and Grace uses its own interface to the
Cloud speech relay. Those launch paths use neither pending module.

The agent host binds its Cloud inference model during launch. The pending
[event publisher](conversation/events.md) and
[device-action operation schemas](deviceActions/operations.md) still
need their respective agent implementations before consumers can import
them from the package root.
