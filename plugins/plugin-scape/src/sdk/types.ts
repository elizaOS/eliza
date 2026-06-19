/**
 * Mirror of the xRSPS bot-SDK protocol types.
 *
 * The shapes here MUST stay byte-compatible with xRSPS's
 * `server/src/network/botsdk/BotSdkProtocol.ts` — the JSON codec does
 * structural matching, not schema versioning, so a rename on either side
 * silently breaks the wire format.
 *
 * Keep this file a thin set of types only. Runtime logic (reconnect,
 * action queueing, state caching) lives in `./index.ts` so type changes
 * can be reviewed in isolation.
 */

// ─── Authentication / session frames (client → server) ───────────────────

export interface AuthFrame {
  kind: "auth";
  token: string;
  version?: number;
}

export interface SpawnFrame {
  kind: "spawn";
  agentId: string;
  displayName: string;
  /**
   * Plaintext password. Sent once over the bot-SDK WebSocket; the
   * xRSPS server scrypt-verifies or auto-registers. Never log this.
   */
  password: string;
  persona?: string;
  controller?: "llm" | "user" | "hybrid";
}

export interface DisconnectFrame {
  kind: "disconnect";
  reason?: string;
}

// ─── Action frames (client → server) ─────────────────────────────────────

interface ActionEnvelope {
  kind: "action";
  action: string;
  correlationId?: string;
}

export interface WalkToAction extends ActionEnvelope {
  action: "walkTo";
  x: number;
  z: number;
  run?: boolean;
}

export interface ChatPublicAction extends ActionEnvelope {
  action: "chatPublic";
  text: string;
}

export interface AttackNpcAction extends ActionEnvelope {
  action: "attackNpc";
  npcId: number;
}

export interface DropItemAction extends ActionEnvelope {
  action: "dropItem";
  slot: number;
}

export interface EatFoodAction extends ActionEnvelope {
  action: "eatFood";
  slot?: number;
}

export type AnyActionFrame =
  | WalkToAction
  | ChatPublicAction
  | AttackNpcAction
  | DropItemAction
  | EatFoodAction;

/**
 * Payload shape accepted by `BotManager.sendAction` /
 * `ScapeGameService.executeAction`. A naive `Omit<AnyActionFrame, …>`
 * collapses the discriminated union into a structural intersection,
 * which drops every variant-specific field (`x`, `z`, `npcId`, …).
 *
 * The conditional `T extends AnyActionFrame ? Omit<T, …> : never`
 * distributes the Omit across each member of the union, preserving
 * each variant's shape, so callers can build `{ action: "walkTo", x,
 * z }` without the compiler crying about unknown properties.
 */
export type ActionFramePayload = AnyActionFrame extends infer T
  ? T extends AnyActionFrame
    ? Omit<T, "kind" | "correlationId">
    : never
  : never;

export type ClientFrame =
  | AuthFrame
  | SpawnFrame
  | AnyActionFrame
  | DisconnectFrame;

// ─── Server frames (server → client) ─────────────────────────────────────

export interface AuthOkFrame {
  kind: "authOk";
  server: string;
  version: number;
}

export interface ErrorFrame {
  kind: "error";
  code: string;
  message: string;
}

export interface SpawnOkFrame {
  kind: "spawnOk";
  playerId: number;
  x: number;
  z: number;
  level: number;
}

export interface ActionAckFrame {
  kind: "ack";
  correlationId: string;
  success: boolean;
  message?: string;
}

// ─── Perception ──────────────────────────────────────────────────────────

export interface PerceptionSelf {
  id: number;
  name: string;
  combatLevel: number;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  level: number;
  runEnergy: number;
  inCombat: boolean;
}

export interface PerceptionInventoryItem {
  slot: number;
  itemId: number;
  name: string;
  count: number;
}

export interface PerceptionSkill {
  id: number;
  name: string;
  level: number;
  baseLevel: number;
  xp: number;
}

export interface PerceptionNpc {
  id: number;
  defId: number;
  name: string;
  x: number;
  z: number;
  hp?: number;
  combatLevel?: number;
}

export interface PerceptionPlayer {
  id: number;
  name: string;
  x: number;
  z: number;
  combatLevel: number;
}

export interface PerceptionGroundItem {
  itemId: number;
  name: string;
  x: number;
  z: number;
  count: number;
}

export interface PerceptionObject {
  locId: number;
  name: string;
  x: number;
  z: number;
}

export interface PerceptionEvent {
  timestamp: number;
  kind: string;
  message: string;
}

export interface PerceptionSnapshot {
  tick: number;
  self: PerceptionSelf;
  skills: PerceptionSkill[];
  inventory: PerceptionInventoryItem[];
  equipment: PerceptionInventoryItem[];
  nearbyNpcs: PerceptionNpc[];
  nearbyPlayers: PerceptionPlayer[];
  nearbyGroundItems: PerceptionGroundItem[];
  nearbyObjects: PerceptionObject[];
  recentEvents: PerceptionEvent[];
}

export interface PerceptionFrame {
  kind: "perception";
  snapshot: PerceptionSnapshot;
}

/**
 * Operator steering directive pushed from the xRSPS server.
 * Sent when a human player types `::steer <text>` in public chat.
 * The BotSdk surfaces this via `onOperatorCommand`, which the
 * game-service turns into `setOperatorGoal(text)`.
 */
export interface OperatorCommandFrame {
  kind: "operatorCommand";
  source: "chat" | "admin";
  text: string;
  timestamp: number;
  fromPlayerId?: number;
  fromPlayerName?: string;
}

export type ServerFrame =
  | AuthOkFrame
  | ErrorFrame
  | SpawnOkFrame
  | ActionAckFrame
  | PerceptionFrame
  | OperatorCommandFrame;
