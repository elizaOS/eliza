import type { LifeOpsCapabilitiesStatus } from "@elizaos/shared";
import { type StatusDeps, StatusDomain } from "./domains/status-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsStatusService {
  getCapabilityStatus(now?: Date): Promise<LifeOpsCapabilitiesStatus>;
}

/**
 * Base constraint for the status composition cast in `service.ts`. The status
 * aggregator reads these cross-domain methods off the composed runtime via
 * {@link StatusDeps}; this alias keeps the explicit composition-root cast typed.
 */
export type StatusMixinDependencies = LifeOpsServiceBase & StatusDeps;

/** @internal */
export function withStatus<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsStatusService> {
  class LifeOpsStatusServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly statusDomain = new StatusDomain(this, {
      getScheduleMergedState: (...args) =>
        (this as unknown as StatusDeps).getScheduleMergedState(...args),
      getBrowserSettings: (...args) =>
        (this as unknown as StatusDeps).getBrowserSettings(...args),
      listBrowserCompanions: (...args) =>
        (this as unknown as StatusDeps).listBrowserCompanions(...args),
      getXConnectorStatus: (...args) =>
        (this as unknown as StatusDeps).getXConnectorStatus(...args),
      getHealthConnectorStatus: (...args) =>
        (this as unknown as StatusDeps).getHealthConnectorStatus(...args),
    });

    getCapabilityStatus(now?: Date): Promise<LifeOpsCapabilitiesStatus> {
      return this.statusDomain.getCapabilityStatus(now);
    }
  }

  return LifeOpsStatusServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsStatusService
  >;
}
