# @elizaos/cloud-test-mocks

Stateful, in-process mocks of third-party cloud APIs used by Eliza Cloud. Designed for use in unit / integration tests and local development without hitting real provider APIs.

## Hetzner Cloud mock

Implements the subset of the Hetzner Cloud API that the autoscaler client in
`packages/cloud-shared/src/lib/services/containers/hetzner-cloud-api.ts` exercises:

- `POST /v1/servers`, `GET /v1/servers`, `GET /v1/servers/{id}`, `DELETE /v1/servers/{id}`
- `POST /v1/servers/{id}/actions/poweroff|poweron`
- `GET /v1/actions/{id}` — pollable until `status: "success"`
- `POST /v1/volumes`, `POST /v1/volumes/{id}/actions/attach`, `DELETE /v1/volumes/{id}`

State is kept in memory and resets when the process exits.

### Run standalone

```bash
bun run packages/cloud-test-mocks/bin/hetzner-mock.ts --port 4567 --action-ms 500
# or via package script
bun run --cwd packages/cloud-test-mocks start:hetzner -- --port 4567

# Then point the real client at the mock:
export HCLOUD_API_BASE_URL=http://127.0.0.1:4567/v1
export HCLOUD_TOKEN=anything-non-empty
```

### Use programmatically

```ts
import { startHetznerMock } from "@elizaos/cloud-test-mocks/hetzner";

const mock = await startHetznerMock({ port: 0, actionMs: 50 });
process.env.HCLOUD_API_BASE_URL = mock.url;
// ... run tests against the real HetznerCloudClient ...
await mock.stop();
```

### Env knobs

- `HCLOUD_API_BASE_URL` — consumed by the real client (`packages/cloud-shared`) to redirect to the mock.
- `MOCK_HETZNER_LATENCY=0` — disable simulated latency entirely.
- `MOCK_HETZNER_ACTION_MS=<n>` — override the action lifecycle duration (default 2000ms; tests use 50ms).

### Static catalog (Mockoon)

`mockoon/hetzner-static.json` is a Mockoon v6 environment with stub responses
for the read-only catalog endpoints (`/locations`, `/server_types`, `/images`,
`/pricing`). Import it in Mockoon Desktop / CLI when you need a long-lived
catalog mock alongside the stateful Hono mock.
