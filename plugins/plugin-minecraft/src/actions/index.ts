/**
 * Action registry for `@elizaos/plugin-minecraft`.
 *
 * Single planner-facing parent: `MC` (Pattern C) — absorbs the seven
 * old leaves (MC_ATTACK, MC_BLOCK, MC_CHAT, MC_CONNECT, MC_DISCONNECT,
 * MC_LOCOMOTE, MC_WAYPOINT). Old names live as similes for trace
 * continuity.
 */

export { minecraftAction } from "./mc.js";
