/**
 * Re-export shim. The LifeOps normalize/validation primitives are now
 * runtime-level primitives in `@elizaos/shared` (pure, dependency-free beyond
 * `@elizaos/core` and the LifeOps contract types/constants). This file
 * preserves the historical `./service-normalize.js` import path for in-plugin
 * callers.
 */
export {
  lifeOpsErrorMessage,
  fail,
  defaultOwnerEntityId,
  normalizeLifeOpsDomain,
  normalizeLifeOpsSubjectType,
  normalizeLifeOpsVisibilityScope,
  normalizeLifeOpsContextPolicy,
  requireAgentId,
  requireNonEmptyString,
  normalizeOptionalString,
  normalizeOptionalBoolean,
  normalizeIsoString,
  normalizeOptionalIsoString,
  normalizeFiniteNumber,
  normalizeOptionalMinutes,
  normalizePositiveInteger,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalFiniteNumber,
  normalizeEnumValue,
  normalizeValidTimeZone,
  normalizePriority,
  normalizePrivacyClass,
  normalizePhoneNumber,
  normalizeReminderUrgency,
} from "@elizaos/shared";
