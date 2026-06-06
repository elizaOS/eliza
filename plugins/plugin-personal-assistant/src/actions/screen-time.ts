import {
  createOwnerScreenTimeAction,
  createScreenTimeActionRunner,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
} from "@elizaos/plugin-health";
import {
  getActivityReport,
  getTimeOnApp,
} from "../activity-profile/activity-tracker-reporting.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  getBrowserActivitySnapshot,
  getBrowserDomainActivity,
} from "../lifeops/browser-extension-store.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  messageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";
import { isDarwin } from "../platform/host.js";
import { resolveActionArgs } from "./lib/resolve-action-args.js";

export {
  createOwnerScreenTimeAction,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
};

export const runScreenTimeHandler = createScreenTimeActionRunner({
  hasAccess: hasLifeOpsAccess,
  createService: (runtime) => new LifeOpsService(runtime),
  messageText,
  renderReply: renderLifeOpsActionReply,
  resolveActionArgs,
  isDarwin,
  getActivityReport,
  getTimeOnApp,
  getBrowserDomainActivity,
  getBrowserActivitySnapshot,
});
