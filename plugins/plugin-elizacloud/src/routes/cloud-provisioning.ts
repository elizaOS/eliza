// Keep the plugin's historical export path, but make the shared host-layer
// detector the only implementation. This prevents route/UI consumers from
// drifting away from the immutable local-development Cloud authority policy.
export { isCloudProvisionedContainer } from "@elizaos/shared";
