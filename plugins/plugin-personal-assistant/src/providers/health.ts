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
