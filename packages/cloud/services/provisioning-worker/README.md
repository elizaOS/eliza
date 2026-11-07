# Cloud provisioning workers

Node service composition for agent-fleet and apps provisioning. Both workers use
shared durable job authority; the apps worker claims only its configured apps lane.
Systemd units remain in `packages/cloud/scripts/admin` and set the deployed environment.

From the repository root:

```sh
bun run --cwd packages/cloud/services/provisioning-worker typecheck
bun run --cwd packages/cloud/services/provisioning-worker start
bun run --cwd packages/cloud/services/provisioning-worker start:apps
```

Starting a worker performs infrastructure operations. Use the existing development
configuration and isolated resources for local execution.

This package has no local test suite. Shared worker health checks are covered by
[`provisioning-worker-health-connections.test.ts`](../../shared/src/lib/services/provisioning-worker-health-connections.test.ts).
