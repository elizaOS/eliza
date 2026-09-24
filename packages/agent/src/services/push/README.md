# Remote push (APNs / FCM)

Server-side delivery of agent notifications to **backgrounded/killed** devices.

This directory is part of `packages/agent`.

Build from the repository root:

```bash
bun run --cwd packages/agent build
```

Test from the repository root:

```bash
bun run --cwd packages/agent test
```

Push acceptance requires an enrolled device, token registration through the
authenticated API, and confirmation of notification delivery on that device.
The local agent suite does not verify device delivery.
