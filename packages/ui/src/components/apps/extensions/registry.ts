// Re-export shim: the detail-extension registry now lives in `@elizaos/shared`
// so Node app-registration code shares one canonical registry without importing
// the React package.
export {
  getAppDetailExtension,
  registerDetailExtension,
} from "@elizaos/shared";
