/* ------------------------------------------------------------------ */
/*  2004scape SDK — shared type definitions                           */
/* ------------------------------------------------------------------ */

export interface Position {
  x: number;
  z: number;
  level?: number;
}

export interface PlayerState {
  name: string;
  combatLevel: number;
  hp: number;
  maxHp: number;
  worldX: number;
  worldZ: number;
  level: number;
  animId: number;
  runEnergy: number;
  runWeight: number;
  inCombat: boolean;
  combatTarget: string | null;
  lastDamageTick: number;
}

export interface SkillState {
  id: number;
  name: string;
  level: number;
  baseLevel: number;
  xp: number;
}

export interface InventoryItem {
  id: number;
  name: string;
  count: number;
  slot: number;
}

export interface EquipmentItem {
  slot: number;
  slotName: string;
  id: number;
  name: string;
}

export interface NearbyNpc {
  nid: number;
  name: string;
  combatLevel: number;
  worldX: number;
  worldZ: number;
  distance: number;
  options: string[];
  inCombat?: boolean;
}

export interface NearbyLoc {
  locId: number;
  name: string;
  worldX: number;
  worldZ: number;
  distance: number;
  options: string[];
}

export interface GroundItem {
  id: number;
  name: string;
  count: number;
  worldX: number;
  worldZ: number;
  distance: number;
}

export interface GameMessage {
  text: string;
  type: string;
  tick: number;
}

export interface CombatEvent {
  type: "damage" | "kill" | "death";
  source: string;
  target: string;
  amount?: number;
  tick: number;
}

export interface DialogState {
  isOpen: boolean;
  npcName: string | null;
  text: string | null;
  options: string[];
}

export interface ShopState {
  isOpen: boolean;
  name: string | null;
  items: ShopItem[];
}

export interface ShopItem {
  id: number;
  name: string;
  price: number;
  stock: number;
  slot: number;
}

export interface BankState {
  isOpen: boolean;
  items: BankItem[];
}

export interface BankItem {
  id: number;
  name: string;
  count: number;
  slot: number;
}

export interface CombatStyleState {
  currentStyle: number;
  weaponName: string;
  styles: CombatStyle[];
}

export interface CombatStyle {
  name: string;
  xpType: string;
}

export interface BotWorldState {
  tick: number;
  inGame: boolean;
  player: PlayerState | null;
  skills: SkillState[];
  inventory: InventoryItem[];
  equipment: EquipmentItem[];
  nearbyNpcs: NearbyNpc[];
  nearbyLocs: NearbyLoc[];
  groundItems: GroundItem[];
  gameMessages: GameMessage[];
  combatEvents: CombatEvent[];
  dialog: DialogState | null;
  shop: ShopState | null;
  bank: BankState | null;
  combatStyle: CombatStyleState | null;
  modalOpen: boolean;
  recentDialogs: DialogState[];
}

/* ------------------------------------------------------------------ */
/*  Bot state as consumed by providers                                 */
/* ------------------------------------------------------------------ */

export interface BotState {
  connected: boolean;
  inGame: boolean;
  player: PlayerState | null;
  skills: SkillState[];
  inventory: InventoryItem[];
  equipment: EquipmentItem[];
  nearbyNpcs: NearbyNpc[];
  nearbyLocs: NearbyLoc[];
  groundItems: GroundItem[];
  gameMessages: GameMessage[];
  combatEvents: CombatEvent[];
  dialog: DialogState | null;
  shop: ShopState | null;
  bank: BankState | null;
  combatStyle: CombatStyleState | null;
  alerts: BotAlert[];
}

export interface BotAlert {
  type:
    | "inventory_full"
    | "low_hp"
    | "no_food"
    | "in_combat"
    | "inventory_nearly_full";
  message: string;
}

/* ------------------------------------------------------------------ */
/*  SDK action types                                                   */
/* ------------------------------------------------------------------ */

export type BotAction =
  | { type: "walkTo"; x: number; z: number; reason?: string }
  | { type: "interactLoc"; locId: number; opIndex?: number }
  | { type: "interactNpc"; nid: number; opIndex?: number }
  | { type: "attackNpc"; nid: number }
  | { type: "talkToNpc"; nid: number }
  | { type: "useInventory"; slot: number }
  | { type: "equipItem"; slot: number }
  | { type: "unequipItem"; slot: number }
  | { type: "dropItem"; slot: number }
  | { type: "pickupItem"; id: number; x: number; z: number }
  | { type: "useItemOnItem"; slot1: number; slot2: number }
  | { type: "useItemOnLoc"; slot: number; locId: number }
  | { type: "useItemOnNpc"; slot: number; nid: number }
  | { type: "dialogOption"; option: number }
  | { type: "openBank" }
  | { type: "closeBank" }
  | { type: "depositItem"; slot: number; count: number }
  | { type: "withdrawItem"; slot: number; count: number }
  | { type: "openShop"; nid: number }
  | { type: "closeShop" }
  | { type: "buyItem"; slot: number; count: number }
  | { type: "sellItem"; slot: number; count: number }
  | { type: "setCombatStyle"; style: number }
  | { type: "castSpell"; spellId: number; targetNid?: number };

export interface ActionResult {
  success: boolean;
  action: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface EventLogEntry {
  timestamp: number;
  action: string;
  result: ActionResult;
  stepNumber: number;
}

/* ------------------------------------------------------------------ */
/*  Gateway message types                                              */
/* ------------------------------------------------------------------ */

export interface BotClientMessage {
  type: "sdk_state";
  state: BotWorldState;
}

export interface SDKMessage {
  type: "sdk_action";
  action: BotAction;
  id?: string;
}

export interface SyncToBotMessage {
  type: "sdk_action";
  action: BotAction;
  id?: string;
}

export interface SyncToSDKMessage {
  type: "sdk_state";
  state: BotWorldState;
}

export interface SDKActionAck {
  type: "sdk_action_ack";
  id: string;
  success: boolean;
  message?: string;
}

export interface GatewayLoginMessage {
  type: "login";
  username: string;
  password: string;
}
