/**
 * Status service mixin: declares the LifeOps capability-status service surface
 * and the mixin that composes the status domain's readiness/capability methods
 * onto the LifeOpsService base.
 */
import type { LifeOpsCapabilitiesStatus } from "@elizaos/shared";
import type { StatusDeps } from "./domains/status-service.js";
import type { LifeOpsServiceBase } from "./service-mixin-core.js";

export interface LifeOpsStatusService {
  getCapabilityStatus(now?: Date): Promise<LifeOpsCapabilitiesStatus>;
}

/**
 * Base constraint for the status composition cast in `service.ts`. The status
 * aggregator reads these cross-domain methods off the composed runtime via
 * {@link StatusDeps}; this alias keeps the explicit composition-root cast typed.
 */
export type StatusMixinDependencies = LifeOpsServiceBase & StatusDeps;
