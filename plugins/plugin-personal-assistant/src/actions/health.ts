import {
  createOwnerHealthAction,
  createHealthActionRunner,
  HEALTH_PARAMETERS,
  HEALTH_SIMILES,
} from "@elizaos/plugin-health";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { runLifeOpsJsonModel } from "../lifeops/google/format-helpers.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  messageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";
import { recentConversationTexts } from "./lib/recent-context.js";

export { createOwnerHealthAction, HEALTH_PARAMETERS, HEALTH_SIMILES };

export const runHealthHandler = createHealthActionRunner({
  hasAccess: hasLifeOpsAccess,
  createService: (runtime) => new LifeOpsService(runtime),
  messageText,
  renderReply: renderLifeOpsActionReply,
  recentConversationTexts,
  runJsonModel: runLifeOpsJsonModel,
});
