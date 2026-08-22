# @elizaos/cloud-test-mocks

Stateful, in-process mocks of third-party cloud APIs used by Eliza Cloud. Designed for use in unit / integration tests and local development without hitting real provider APIs.

## Managed provider contract harness

`@elizaos/cloud-test-mocks/provider-contract` provides a reusable real-HTTP
fake upstream and adapter conformance runner. It includes OAuth Authorization
Code + state + PKCE, rotating refresh credentials, revoked/expired credentials,
fixture responses, deterministic faults, signed webhook delivery, redacted
request inspection, and policy receipts.

Suites declare an `outbound-http` or `inbound-webhook` profile. The audit binds
that profile and the capability list to the executed nonce report, so a caller
cannot omit mandatory scenarios or claim OAuth credential lifecycle behavior
when it only implements the callback/state/PKCE boundary.

Action fixtures declare provider-owned account grants and policy decisions.
The upstream authenticates and authorizes the request, performs or rejects the
effect, and emits a canonical `EffectReceipt` in one boundary operation. Tests
can inspect returned receipt/effect snapshots, but cannot mint receipts. Every
receipt binds the tenant, account, opaque connection, capability, policy and
confirmation result, request/idempotency identity, provider result, and actual
effect; replay and denial are explicit non-applied outcomes.

```ts
import {
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";

const upstream = await startFakeProvider({ fixtures });
const adapter = new RealProviderAdapter({ baseUrl: upstream.url });

await runProviderAdapterConformance({
  adapterName: "RealProviderAdapter",
  profile: "outbound-http",
  capabilities: ["http-read", "pagination"],
  scenarios: {
    success: async () => {
      await adapter.list();
      return {
        scenario: "success",
        status: "passed",
        detail: "real adapter response inspected",
      };
    },
    // Add every always-required and capability-derived scenario. An optional
    // requiredScenarios list can only add adapter-specific coverage.
  },
});

await upstream.stop();
```

See `fixtures/provider-contract/README.md` and
`provider-contract-inventory.json`. Every inventory ID must also appear in the
append-only `provider-contract-protected-integrations.json` ledger. The
`audit:provider-contracts` command rejects
missing suites, undeclared promotions, focused/skipped suites, unknown
or duplicate capabilities, removal of any integration ID visible in reachable
repository history, ledger/inventory drift, or a mismatch between
declared capabilities and nonce-bound observations emitted by the executed
suite. Normal CI is fully offline and credential-free; live/sandbox lanes
remain optional.

## Wallet EVM JSON-RPC mock

`@elizaos/cloud-test-mocks/wallet-evm` runs a resettable Base-compatible
JSON-RPC HTTP simulator. It accepts real locally signed EIP-1559 transactions,
deduplicates raw submissions, mines deterministic blocks, applies native-value
effects before emitting success receipts, emits reverted receipts without an
effect, and rolls mined state and receipts back during a reorg. Seed/reset,
auth, rate-limit/provider/malformed/stall faults, generation fencing, and
credential/raw-transaction-redacted readback are available through the store.
The HTTP boundary accepts only uncompressed UTF-8 `application/json`, caps the
body at 64 KiB and the decoded graph at 16 levels/2,048 nodes, and returns only
stable allowlisted protocol errors; dependency failures and adapter exceptions
cannot reflect raw requests or credentials.

The simulator intentionally implements a focused native-transfer subset, not
a general EVM. Contract execution, logs, gas charging, and multichain behavior
remain unsupported and must never be inferred from a passing receipt.

## Hetzner Cloud mock

Implements the subset of the Hetzner Cloud API that the autoscaler client in
`packages/cloud/shared/src/lib/services/containers/hetzner-cloud-api.ts` exercises:

- `POST /v1/servers`, `GET /v1/servers`, `GET /v1/servers/{id}`, `DELETE /v1/servers/{id}`
- `POST /v1/servers/{id}/actions/poweroff|poweron`
- `GET /v1/actions/{id}` — pollable until `status: "success"`
- `POST /v1/volumes`, `POST /v1/volumes/{id}/actions/attach`, `DELETE /v1/volumes/{id}`

State is kept in memory and resets when the process exits.

### Run standalone

```bash
bun run packages/cloud/test-mocks/bin/hetzner-mock.ts --port 4567 --action-ms 500
# or via package script
bun run --cwd packages/cloud/test-mocks start:hetzner -- --port 4567

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

- `HCLOUD_API_BASE_URL` — consumed by the real client (`packages/cloud/shared`) to redirect to the mock.
- `MOCK_HETZNER_LATENCY=0` — disable simulated latency entirely.
- `MOCK_HETZNER_ACTION_MS=<n>` — override the action lifecycle duration (default 2000ms; tests use 50ms).

## Mockoon environments

Stateless mock environments for read-only endpoints, suitable for designer
workflows and quick demos that don't need the stateful Hono mocks running.

- `mockoon/hetzner-static.json` — Hetzner read-only catalog (`/locations`,
  `/server_types`, `/images`, `/pricing`).
- `mockoon/control-plane-static.json` — Control-plane read-only endpoints:
  `GET /api/v1/admin/warm-pool`, `GET /api/v1/admin/warm-pool/rollout-status`,
  `GET /api/v1/admin/docker-nodes`,
  `POST /api/v1/admin/docker-nodes/:id/health-check`,
  `GET /api/v1/cron/deployment-monitor`, `GET /api/v1/cron/agent-hot-pool`,
  `GET /api/v1/cron/node-autoscale`, `GET /api/compat/agents/:id`.

Import either file in Mockoon Desktop, or run via Mockoon CLI:

```bash
mockoon-cli start --data mockoon/control-plane-static.json
mockoon-cli start --data mockoon/hetzner-static.json
```
