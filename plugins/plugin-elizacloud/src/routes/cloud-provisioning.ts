// Canonical implementation lives in `@elizaos/shared` so host-layer callers
// (e.g. @elizaos/agent) can detect cloud-provisioned containers without
// dynamically importing this plugin at module scope.
export { isCloudProvisionedContainer } from "@elizaos/shared";
