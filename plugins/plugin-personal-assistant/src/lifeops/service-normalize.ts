/**
 * Re-export shim. The LifeOps normalize/validation primitives are now
 * runtime-level primitives in `@elizaos/core` (pure, dependency-free beyond
 * `@elizaos/core` and the LifeOps contract types/constants). This file
 * preserves the historical `./service-normalize.js` import path for in-plugin
 * callers.
 */

export { defaultOwnerEntityId } from "@elizaos/core/lifeops-normalize/owner-entity";
export {
  fail,
  lifeOpsErrorMessage,
  normalizeEnumValue,
  normalizeFiniteNumber,
  normalizeIsoString,
  normalizeLifeOpsContextPolicy,
  normalizeLifeOpsDomain,
  normalizeLifeOpsSubjectType,
  normalizeLifeOpsVisibilityScope,
  normalizeOptionalBoolean,
  normalizeOptionalFiniteNumber,
  normalizeOptionalIsoString,
  normalizeOptionalMinutes,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalString,
  normalizePhoneNumber,
  normalizePositiveInteger,
  normalizePriority,
  normalizePrivacyClass,
  normalizeReminderUrgency,
  normalizeValidTimeZone,
  requireAgentId,
  requireNonEmptyString,
} from "@elizaos/core/lifeops-normalize/service-normalize";
