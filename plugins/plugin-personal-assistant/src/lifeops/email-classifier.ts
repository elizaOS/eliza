/**
 * Re-export shim. The email classifier is now a runtime-level primitive in
 * `@elizaos/shared` so both inbox-curation and finance bill-extraction can
 * consume it without cross-domain coupling. This file preserves the historical
 * import path for in-plugin callers.
 */
export {
  classifyEmail,
  classifyEmailByRules,
  getConfiguredEmailClassifierModel,
  isEmailClassifierEnabled,
  _resetEmailClassifierCache,
} from "@elizaos/shared";
export type {
  ClassifyEmailOptions,
  EmailCategory,
  EmailClassification,
  EmailLikeMessage,
} from "@elizaos/shared";
