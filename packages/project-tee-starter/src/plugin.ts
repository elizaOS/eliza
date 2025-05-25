import type { Plugin } from '@elizaos/core';
import { TappdClient } from '@phala/dstack-sdk';
// Create a custom TEE Client to make calls to the TEE through the Dstack SDK.

export const teeStarterPlugin: Plugin = {
  name: 'mr-tee-starter-plugin',
  description: "Mr. TEE's starter plugin - using plugin-tee for attestation",
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};

export default teeStarterPlugin;
