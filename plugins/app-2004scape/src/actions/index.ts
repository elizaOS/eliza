export {
  rs2004BankingAction,
  rs2004CombatAction,
  rs2004DialogueAction,
  rs2004InteractionAction,
  rs2004InventoryAction,
  rs2004MovementAction,
  rs2004RouterActions,
  rs2004ShopAction,
  rs2004SkillingAction,
} from "./routers.js";
export {
  RS_2004_ACTION_ROUTER_DEFINITIONS,
  formatRs2004RouterPrompt,
  isRs2004RouterActionName,
  resolveRs2004RouterAction,
} from "./router-definitions.js";

import { rs2004RouterActions } from "./routers.js";

export const rsSdkActions = rs2004RouterActions;
