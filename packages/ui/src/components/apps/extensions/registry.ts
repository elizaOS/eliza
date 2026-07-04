/**
 * Re-export of the app detail-extension registry. The canonical registry lives
 * in `@elizaos/shared` so Node app-registration code shares it without importing
 * this React package.
 */
export {
  getAppDetailExtension,
  registerDetailExtension,
} from "@elizaos/shared";
