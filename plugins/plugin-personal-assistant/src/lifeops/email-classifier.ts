/**
 * Re-export shim. The email classifier is now a runtime-level primitive in
 * `@elizaos/plugin-personal-assistant/email-classification` so both inbox-curation and finance bill-extraction can
 * consume it without cross-domain coupling. This file preserves the historical
 * import path for in-plugin callers.
 */
export {
  _resetEmailClassifierCache,
  type ClassifyEmailOptions,
  classifyEmail,
  classifyEmailByRules,
  type EmailCategory,
  type EmailClassification,
  type EmailLikeMessage,
  getConfiguredEmailClassifierModel,
  isEmailClassifierEnabled,
} from "../email-classification/email-classifier.js";
