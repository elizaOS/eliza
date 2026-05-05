export {
  rs2004AllActions,
  rs2004BankOpAction,
  rs2004CombatOpAction,
  rs2004InteractOpAction,
  rs2004InventoryOpAction,
  rs2004RouterActions,
  rs2004ShopOpAction,
  rs2004SkillOpAction,
  rs2004WalkToAction,
} from "./routers.js";
export {
  RS_2004_ACTION_ROUTER_DEFINITIONS,
  formatRs2004RouterPrompt,
  isRs2004RouterActionName,
  resolveRs2004RouterAction,
} from "./router-definitions.js";

import { rs2004AllActions } from "./routers.js";

export const rsSdkActions = rs2004AllActions;
