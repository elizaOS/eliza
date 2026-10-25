/**
 * `lifeops-health` provider — thin wrapper built by `@elizaos/plugin-health`'s
 * `createHealthProvider`, wired to the LifeOps access gate and `LifeOpsService`
 * so owner health summaries surface in assistant context.
 */

import { createHealthProvider } from "@elizaos/plugin-health";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { LifeOpsService } from "../lifeops/service.js";

export const healthProvider = createHealthProvider({
  hasAccess: hasLifeOpsAccess,
  getSummary: async (runtime, request) => {
    const service = new LifeOpsService(runtime);
    return service.getHealthSummary(request);
  },
});
