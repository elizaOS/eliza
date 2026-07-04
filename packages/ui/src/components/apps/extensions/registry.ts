/**
 * App detail-extension registry.
 *
 * The registry state and functions now live in `@elizaos/shared`
 * (`contracts/app-registries`) so the Node runtime can register/query detail
 * extensions without dragging the React component graph in. This module
 * re-exports them so existing browser importers keep working unchanged.
 */

export {
  getAppDetailExtension,
  registerDetailExtension,
} from "@elizaos/shared";
