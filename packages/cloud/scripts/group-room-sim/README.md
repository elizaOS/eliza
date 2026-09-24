# Group-room consent and transport fixtures

`coparent-consent-scenario.ts` defines the deterministic co-parent consent
choreography and evidence ledger. Use it to drive consent ordering and cross-service invariants in a local stack.

No separate build or dedicated test suite is defined in this directory.

`mock-blooio-provider.ts` supplies a local provider boundary for transport
exercises. `gateway-fetch-tap.preload.ts` records gateway fetch observations.
Use their documented environment configuration when running a local cloud stack.
