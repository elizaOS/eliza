/**
 * Shared state and infrastructure every LifeOps domain sub-service depends on.
 *
 * Derived via `Pick` from {@link LifeOpsServiceBase} so the context surface can
 * never drift from the real implementation. A `LifeOpsService` instance (which
 * extends `LifeOpsServiceBase`) satisfies this structurally, so the composition
 * root passes `this` as the context when constructing domain sub-services.
 *
 * Domain-specific helpers on the base (browser-settings reads, google/x grant
 * mutation, workflow-definition lookup, the per-domain `record*Audit` wrappers,
 * the adaptive-window cache, the reminder-processing lock) are intentionally NOT
 * part of the shared context — they belong to their owning domain and are
 * injected as typed sub-service dependencies instead.
 */
import type { LifeOpsServiceBase } from "./service-mixin-core.js";
export type LifeOpsContext = Pick<
  LifeOpsServiceBase,
  | "runtime"
  | "repository"
  | "scheduleSyncClient"
  | "explicitOwnerEntityIdValue"
  | "ownerEntityIdValue"
  | "ownerRoutingEntityIdPromise"
  | "agentId"
  | "ownerEntityId"
  | "ownerRoutingEntityId"
  | "normalizeOwnership"
  | "normalizeChildOwnership"
  | "logLifeOpsWarn"
  | "logLifeOpsError"
  | "emitAssistantEvent"
  | "recordAudit"
  | "recordConnectorAudit"
  | "recordChannelPolicyAudit"
>;
