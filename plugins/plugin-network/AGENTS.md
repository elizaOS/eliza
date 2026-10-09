# @elizaos/plugin-network

The Network's conversation layer on the shared Eliza agent (eliza.app is an entry into The Network).

- **Boundary.** This package talks to the Network service (eliza-research/thenetwork, Railway) only over the signed `/internal/*` contract in `src/backend/` (`SERVICE_TURN_SECRET`, HMAC-SHA256; see `svc-auth.ts`). It imports nothing from the thenetwork repo. thenetwork keeps a byte-for-byte mirror of `contract.ts` and `svc-auth.ts` in `packages/core/src/svc/`; change both together and bump `CONTRACT_VERSION`.
- **`src/backend/contract.ts` and `svc-auth.ts` stay import-free** (the service loads its mirror without Eliza).
- **Turns.** The gateway (`packages/cloud/services/gateway-webhook/src/network-service.ts`) calls `/internal/turn` first; handled turns never reach the model. Open turns run here with a service-backed `NetworkStore` (`createServiceNetworkStore`).
- **State changes** go only through the structured `networkAction` field plus deterministic authz (`routing/authz.ts`, `routing/dates.ts`); the planner `SET_STATE` action exists only for `routing: "planner"`.
- **Tests:** integration and e2e only (Cloud PGlite, the Workerd shared-runtime harness, gateway `network-takeover.test.ts`, Cloud `internal/network/deliver/route.test.ts`), plus the live model eval.
