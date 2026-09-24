# Group-room consent and transport fixtures

`coparent-consent-scenario.ts` defines the deterministic co-parent consent
choreography and evidence ledger. Its tests verify ordering and cross-service
invariants without contacting a live service.

```sh
bun test packages/cloud/scripts/group-room-sim/coparent-consent-scenario.test.ts
```

`mock-blooio-provider.ts` supplies a local provider boundary for transport
exercises. `gateway-fetch-tap.preload.ts` records gateway fetch observations.
Use their documented environment configuration when running a local cloud stack.
