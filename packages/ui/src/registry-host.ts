/**
 * Re-export shim for the UI registry host, which lives in `@elizaos/shared` so
 * Node app-registration code shares one canonical store singleton without
 * importing the React package. See `@elizaos/shared/src/registry-host.ts`.
 */
export {
  getUiRegistryStore,
  provideUiRegistryHost,
  resetUiRegistryHostForTests,
  type UiRegistryHost,
} from "@elizaos/shared";
