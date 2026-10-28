import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { managedCalendarSyncProvider } from "@elizaos/cloud-shared/lib/services/agent-google-connector/calendar-sync-managed";
import { createCalendarSyncRoutes } from "@elizaos/cloud-shared/lib/services/agent-google-connector/calendar-sync-routes";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.route(
  "/",
  createCalendarSyncRoutes<AppEnv>({
    provider: managedCalendarSyncProvider,
    async authenticate(context) {
      const user = await requireUserOrApiKeyWithOrg(context);
      await requirePrivateOwnerAccess(context, user);
      return { organizationId: user.organization_id, userId: user.id };
    },
    onError: (error, context) => failureResponse(context, error),
  }),
);
export default app;
