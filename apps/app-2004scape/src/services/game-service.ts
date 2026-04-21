import { Service, ModelType, type IAgentRuntime } from "@elizaos/core";
import { BotManager } from "./bot-manager.js";
import { BotActions } from "../sdk/actions.js";
import type { BotState, ActionResult, EventLogEntry } from "../sdk/types.js";
import { startGateway, type GatewayHandle } from "../gateway/index.js";
import { setCurrentLlmResponse } from "../shared-state.js";
import { botStateProvider } from "../providers/bot-state.js";
import { goalsProvider } from "../providers/goals.js";
import { mapAreaProvider } from "../providers/map-area.js";
import { worldKnowledgeProvider } from "../providers/world-knowledge.js";

const DEFAULT_GATEWAY_PORT = 18791;
const DEFAULT_LOOP_INTERVAL_MS = 15_000;
const MAX_EVENT_LOG = 30;

/** Map user-facing size names to ModelType constants. */
const MODEL_SIZE_MAP: Record<string, string> = {
  TEXT_NANO: ModelType.TEXT_NANO,
  TEXT_SMALL: ModelType.TEXT_SMALL,
  TEXT_MEDIUM: ModelType.TEXT_MEDIUM,
  TEXT_LARGE: ModelType.TEXT_LARGE,
  NANO: ModelType.TEXT_NANO,
  SMALL: ModelType.TEXT_SMALL,
  MEDIUM: ModelType.TEXT_MEDIUM,
  LARGE: ModelType.TEXT_LARGE,
};

const DEFAULT_MODEL_SIZE = ModelType.TEXT_SMALL;

/** All actions the LLM can choose from. Name → param hint shown in prompt. */
const ACTION_LIST = [
  { name: "WALK_TO", params: "<destination>name</destination> OR <x>N</x><z>N</z>" },
  { name: "OPEN_DOOR", params: "(no params — opens nearest door/gate)" },
  { name: "TALK_TO_NPC", params: "<npc>name</npc>" },
  { name: "NAVIGATE_DIALOG", params: "<option>1-based index</option>" },
  { name: "INTERACT_OBJECT", params: "<object>name</object> <option>action</option>" },
  { name: "CHOP_TREE", params: "<tree>type (optional)</tree>" },
  { name: "MINE_ROCK", params: "<rock>type (optional)</rock>" },
  { name: "FISH", params: "<spot>type (optional)</spot>" },
  { name: "ATTACK_NPC", params: "<npc>name</npc>" },
  { name: "EAT_FOOD", params: "(no params — eats first food found)" },
  { name: "SET_COMBAT_STYLE", params: "<style>0=Atk 1=Str 2=Def 3=Ctrl</style>" },
  { name: "DROP_ITEM", params: "<item>name</item>" },
  { name: "PICKUP_ITEM", params: "<item>name</item>" },
  { name: "EQUIP_ITEM", params: "<item>name</item>" },
  { name: "UNEQUIP_ITEM", params: "<item>name</item>" },
  { name: "USE_ITEM", params: "<item>name</item>" },
  { name: "USE_ITEM_ON_ITEM", params: "<item1>name</item1><item2>name</item2>" },
  { name: "USE_ITEM_ON_OBJECT", params: "<item>name</item><object>name</object>" },
  { name: "OPEN_BANK", params: "(no params — finds nearest bank)" },
  { name: "CLOSE_BANK", params: "(no params)" },
  { name: "DEPOSIT_ITEM", params: "<item>name</item> <count>N (optional)</count>" },
  { name: "WITHDRAW_ITEM", params: "<item>name</item> <count>N (optional)</count>" },
  { name: "OPEN_SHOP", params: "<npc>shopkeeper name</npc>" },
  { name: "CLOSE_SHOP", params: "(no params)" },
  { name: "BUY_FROM_SHOP", params: "<item>name</item> <count>N</count>" },
  { name: "SELL_TO_SHOP", params: "<item>name</item> <count>N</count>" },
  { name: "BURN_LOGS", params: "(no params — uses tinderbox on logs)" },
  { name: "COOK_FOOD", params: "<food>raw food name (optional)</food>" },
  { name: "FLETCH_LOGS", params: "(no params)" },
  { name: "CRAFT_LEATHER", params: "(no params)" },
  { name: "SMITH_AT_ANVIL", params: "<item>item to smith (optional)</item>" },
  { name: "PICKPOCKET_NPC", params: "<npc>name</npc>" },
  { name: "CAST_SPELL", params: "<spell>spellId</spell> <target>npcNid (optional)</target>" },
];

/** Map action names from LLM response to dispatch keys. */
const ACTION_NAME_TO_DISPATCH: Record<string, string> = {
  WALK_TO: "walkTo",
  OPEN_DOOR: "openDoor",
  TALK_TO_NPC: "talkToNpc",
  NAVIGATE_DIALOG: "navigateDialog",
  INTERACT_OBJECT: "interactObject",
  CHOP_TREE: "chopTree",
  MINE_ROCK: "mineRock",
  FISH: "fish",
  ATTACK_NPC: "attackNpc",
  EAT_FOOD: "eatFood",
  SET_COMBAT_STYLE: "setCombatStyle",
  DROP_ITEM: "dropItem",
  PICKUP_ITEM: "pickupItem",
  EQUIP_ITEM: "equipItem",
  UNEQUIP_ITEM: "unequipItem",
  USE_ITEM: "useItem",
  USE_ITEM_ON_ITEM: "useItemOnItem",
  USE_ITEM_ON_OBJECT: "useItemOnObject",
  OPEN_BANK: "openBank",
  CLOSE_BANK: "closeBank",
  DEPOSIT_ITEM: "depositItem",
  WITHDRAW_ITEM: "withdrawItem",
  OPEN_SHOP: "openShop",
  CLOSE_SHOP: "closeShop",
  BUY_FROM_SHOP: "buyFromShop",
  SELL_TO_SHOP: "sellToShop",
  BURN_LOGS: "burnLogs",
  COOK_FOOD: "cookFood",
  FLETCH_LOGS: "fletchLogs",
  CRAFT_LEATHER: "craftLeather",
  SMITH_AT_ANVIL: "smithAtAnvil",
  PICKPOCKET_NPC: "pickpocketNpc",
  CAST_SPELL: "castSpell",
};

export class RsSdkGameService extends Service {
  static serviceType = "rs_2004scape";
  capabilityDescription =
    "Autonomous 2004scape game service — connects to the game via WebSocket SDK, runs an LLM-driven game loop.";

  private botManager: BotManager | null = null;
  private botActions: BotActions | null = null;
  private gateway: GatewayHandle | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private loopRunning = false;
  private stepNumber = 0;
  private eventLog: EventLogEntry[] = [];
  private stopped = false;
  private modelSize: string = DEFAULT_MODEL_SIZE;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new RsSdkGameService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    const gatewayPort = this.resolveInt("RS_2004SCAPE_GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
    const loopInterval = this.resolveInt("RS_2004SCAPE_LOOP_INTERVAL_MS", DEFAULT_LOOP_INTERVAL_MS);
    const username = this.resolveSetting("RS_SDK_BOT_NAME") ?? this.resolveSetting("BOT_NAME") ?? "";
    const password = this.resolveSetting("RS_SDK_BOT_PASSWORD") ?? this.resolveSetting("BOT_PASSWORD") ?? "";
    const gatewayUrl = this.resolveSetting("RS_SDK_GATEWAY_URL") ?? `ws://localhost:${gatewayPort}`;

    // Configurable model size: TEXT_NANO, TEXT_SMALL (default), TEXT_MEDIUM, TEXT_LARGE, etc.
    const sizeRaw = (this.resolveSetting("RS_2004SCAPE_MODEL_SIZE") ?? "").toUpperCase();
    this.modelSize = MODEL_SIZE_MAP[sizeRaw] ?? DEFAULT_MODEL_SIZE;
    this.log(`Model size: ${this.modelSize}`);

    if (!username) {
      this.log("No RS_SDK_BOT_NAME configured — game service will not auto-connect.");
      return;
    }

    // Start embedded gateway
    try {
      this.gateway = startGateway({
        port: gatewayPort,
        onLog: (msg) => this.log(msg),
      });
      this.log(`Gateway started on port ${this.gateway.port}`);
    } catch (err) {
      this.log(`Gateway failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Connect SDK to gateway
    this.botManager = new BotManager(gatewayUrl, username, password);
    try {
      this.botManager.connect();
      this.log(`SDK connecting as ${username}`);
    } catch (err) {
      this.log(`SDK connect failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (this.botManager.getSDK()) {
      this.botActions = new BotActions(this.botManager.getSDK()!);
    }

    // Start autonomous game loop
    this.loopTimer = setInterval(() => {
      void this.autonomousStep();
    }, loopInterval);
    this.log(`Game loop started (${loopInterval}ms interval)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    await this.botManager?.disconnect();
    this.gateway?.stop();
    this.log("Game service stopped.");
  }

  /* ------------------------------------------------------------------ */
  /*  Public API (called by providers, actions, route module)            */
  /* ------------------------------------------------------------------ */

  getBotState(): BotState | null {
    return this.botManager?.getBotState() ?? null;
  }

  getEventLog(): EventLogEntry[] {
    return this.eventLog;
  }

  getBotActions(): BotActions | null {
    return this.botActions;
  }

  getGatewayPort(): number | null {
    return this.gateway?.port ?? null;
  }

  isConnected(): boolean {
    return this.botManager?.isConnected() ?? false;
  }

  /**
   * Execute a game action by name. Called by elizaOS action handlers.
   */
  async executeAction(
    actionType: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    if (!this.botActions) {
      return { success: false, action: actionType, message: "Bot actions not initialized." };
    }

    try {
      const result = await this.dispatchAction(actionType, params);
      this.pushEventLog(actionType, result);
      return result;
    } catch (err) {
      const result: ActionResult = {
        success: false,
        action: actionType,
        message: err instanceof Error ? err.message : String(err),
      };
      this.pushEventLog(actionType, result);
      return result;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Autonomous game loop                                               */
  /* ------------------------------------------------------------------ */

  private async autonomousStep(): Promise<void> {
    if (this.loopRunning || this.stopped) return;
    this.loopRunning = true;

    try {
      const botState = this.botManager?.getBotState();
      if (!botState?.connected || !botState.inGame || !botState.player) {
        return;
      }

      this.stepNumber++;

      // 1. Gather provider context
      const providerContext = await this.gatherProviderContext();

      // 2. Build the full prompt
      const prompt = this.buildPrompt(botState, providerContext);

      // 3. Call the LLM with the configured model size
      this.log(`Step ${this.stepNumber} — calling ${this.modelSize}`);
      const response = await this.runtime.useModel(this.modelSize as any, {
        prompt,
        maxTokens: 400,
      });

      if (!response || typeof response !== "string" || response.trim().length === 0) {
        this.log(`Step ${this.stepNumber} — empty LLM response`);
        return;
      }

      this.log(`Step ${this.stepNumber} — LLM: ${response.slice(0, 200)}`);

      // Store for action handlers that might read it
      setCurrentLlmResponse(response);

      // 4. Parse the chosen action from the response
      const parsed = this.parseActionFromResponse(response);
      if (!parsed) {
        this.log(`Step ${this.stepNumber} — could not parse action from response`);
        return;
      }

      // 5. Execute the action
      this.log(`Step ${this.stepNumber} — executing ${parsed.actionType}`);
      const result = await this.executeAction(parsed.actionType, parsed.params);
      this.log(`Step ${this.stepNumber} — ${result.action}: ${result.success ? "OK" : "FAIL"} — ${result.message}`);
    } catch (err) {
      this.log(`Step ${this.stepNumber} error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loopRunning = false;
    }
  }

  private async gatherProviderContext(): Promise<string> {
    const dummy = { content: { text: "" } } as any;
    const sections: string[] = [];

    try {
      sections.push(await mapAreaProvider.get(this.runtime, dummy));
    } catch { /* provider optional */ }
    try {
      sections.push(await worldKnowledgeProvider.get(this.runtime, dummy));
    } catch { /* provider optional */ }
    try {
      sections.push(await goalsProvider.get(this.runtime, dummy));
    } catch { /* provider optional */ }
    try {
      sections.push(await botStateProvider.get(this.runtime, dummy));
    } catch { /* provider optional */ }

    return sections.filter(Boolean).join("\n\n");
  }

  private buildPrompt(state: BotState, providerContext: string): string {
    const p = state.player!;

    const recentActions = this.eventLog
      .slice(-8)
      .map((e) => `  [${e.result.success ? "OK" : "FAIL"}] ${e.action}: ${e.result.message}`)
      .join("\n");

    const actionListStr = ACTION_LIST
      .map((a) => `  ${a.name}: ${a.params}`)
      .join("\n");

    return `You are an autonomous RuneScape bot playing 2004scape. Step ${this.stepNumber}.
Your name: ${p.name} | Combat: ${p.combatLevel} | HP: ${p.hp}/${p.maxHp} | Position: (${p.worldX}, ${p.worldZ}) | Inventory: ${state.inventory.length}/28

${providerContext}

# Action History (recent)
${recentActions || "  (none yet)"}

# Available Actions
Choose exactly ONE action. Respond with <action>ACTION_NAME</action> and any required params in XML tags.
${actionListStr}

# Instructions
- Follow IMMEDIATE goals first (low HP, full inventory).
- Do NOT repeat the same failed action. Try something different.
- If idle or stuck, explore, talk to an NPC, or train a different skill.
- Keep responses SHORT. Just pick an action and provide params.

Your choice:`;
  }

  private parseActionFromResponse(
    response: string,
  ): { actionType: string; params: Record<string, unknown> } | null {
    // Try <action>ACTION_NAME</action> format first
    const actionMatch = response.match(/<action>\s*(\w+)\s*<\/action>/i);
    let actionName: string | null = actionMatch?.[1]?.toUpperCase() ?? null;

    // Fallback: look for any known action name in the response
    if (!actionName) {
      for (const name of Object.keys(ACTION_NAME_TO_DISPATCH)) {
        if (response.toUpperCase().includes(name)) {
          actionName = name;
          break;
        }
      }
    }

    if (!actionName) return null;

    const dispatchKey = ACTION_NAME_TO_DISPATCH[actionName];
    if (!dispatchKey) return null;

    // Extract XML params
    const params: Record<string, unknown> = {};
    const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;
    while ((match = paramRegex.exec(response)) !== null) {
      const key = match[1];
      if (key === "action") continue; // skip the action tag itself
      const val = match[2].trim();
      // Try numeric
      const num = Number(val);
      params[key] = Number.isFinite(num) && /^\d+$/.test(val) ? num : val;
    }

    // Map common XML param names to what dispatchAction expects
    this.mapParamAliases(dispatchKey, params);

    return { actionType: dispatchKey, params };
  }

  /** Normalize param names from LLM XML to dispatchAction expectations. */
  private mapParamAliases(
    actionType: string,
    params: Record<string, unknown>,
  ): void {
    // npc → npcName
    if (params.npc && !params.npcName) params.npcName = params.npc;
    // item → itemName
    if (params.item && !params.itemName) params.itemName = params.item;
    // object → objectName
    if (params.object && !params.objectName) params.objectName = params.object;
    // tree → treeName
    if (params.tree && !params.treeName) params.treeName = params.tree;
    // rock → rockName
    if (params.rock && !params.rockName) params.rockName = params.rock;
    // spot → spotName
    if (params.spot && !params.spotName) params.spotName = params.spot;
    // food → rawFoodName
    if (params.food && !params.rawFoodName) params.rawFoodName = params.food;
    // spell → spellId
    if (params.spell && !params.spellId) params.spellId = params.spell;
    // target → targetNid
    if (params.target && !params.targetNid) params.targetNid = params.target;
    // item1/item2 → itemName1/itemName2
    if (params.item1 && !params.itemName1) params.itemName1 = params.item1;
    if (params.item2 && !params.itemName2) params.itemName2 = params.item2;
    // count defaults
    if (actionType === "depositItem" && params.count == null) params.count = -1;
    if (actionType === "withdrawItem" && params.count == null) params.count = 1;
  }

  /* ------------------------------------------------------------------ */
  /*  Action dispatch                                                    */
  /* ------------------------------------------------------------------ */

  private async dispatchAction(
    actionType: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult> {
    const actions = this.botActions!;
    const str = (key: string): string => String(params[key] ?? "").trim();
    const num = (key: string, fallback: number): number => {
      const v = Number(params[key]);
      return Number.isFinite(v) ? v : fallback;
    };

    switch (actionType) {
      case "walkTo": {
        const dest = str("destination");
        if (dest) return actions.walkToNamed(dest);
        return actions.walkTo(num("x", 0), num("z", 0), str("reason") || undefined);
      }
      case "openDoor":
        return actions.openDoor();
      case "talkToNpc":
        return actions.talkToNpc(str("npcName"));
      case "navigateDialog":
        return actions.navigateDialog(num("option", 1));
      case "interactObject":
        return actions.interactObject(str("objectName"), str("option") || undefined);
      case "chopTree":
        return actions.chopTree(str("treeName") || undefined);
      case "mineRock":
        return actions.mineRock(str("rockName") || undefined);
      case "fish":
        return actions.fish(str("spotName") || undefined);
      case "attackNpc":
        return actions.attackNpc(str("npcName"));
      case "eatFood":
        return actions.eatFood();
      case "setCombatStyle":
        return actions.setCombatStyle(num("style", 0));
      case "castSpell":
        return actions.castSpell(
          num("spellId", 0),
          params.targetNid != null ? num("targetNid", 0) : undefined,
        );
      case "dropItem":
        return actions.dropItem(str("itemName"));
      case "useItem":
        return actions.useItem(str("itemName"));
      case "pickupItem":
        return actions.pickupItem(str("itemName"));
      case "equipItem":
        return actions.equipItem(str("itemName"));
      case "unequipItem":
        return actions.unequipItem(str("itemName"));
      case "useItemOnItem":
        return actions.useItemOnItem(str("itemName1"), str("itemName2"));
      case "openBank":
        return actions.openBank();
      case "closeBank":
        return actions.closeBank();
      case "depositItem":
        return actions.depositItem(str("itemName"), num("count", -1));
      case "withdrawItem":
        return actions.withdrawItem(str("itemName"), num("count", 1));
      case "openShop":
        return actions.openShop(str("npcName"));
      case "closeShop":
        return actions.closeShop();
      case "buyFromShop":
        return actions.buyFromShop(str("itemName"), num("count", 1));
      case "sellToShop":
        return actions.sellToShop(str("itemName"), num("count", 1));
      case "burnLogs":
        return actions.burnLogs();
      case "cookFood":
        return actions.cookFood(str("rawFoodName") || undefined);
      case "fletchLogs":
        return actions.fletchLogs();
      case "craftLeather":
        return actions.craftLeather();
      case "smithAtAnvil":
        return actions.smithAtAnvil(str("itemName") || undefined);
      case "pickpocketNpc":
        return actions.pickpocketNpc(str("npcName"));
      case "useItemOnObject":
        return actions.useItemOnObject(str("itemName"), str("objectName"));
      default:
        return { success: false, action: actionType, message: `Unknown action: ${actionType}` };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private pushEventLog(action: string, result: ActionResult): void {
    this.eventLog.push({
      timestamp: Date.now(),
      action,
      result,
      stepNumber: this.stepNumber,
    });
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog = this.eventLog.slice(-MAX_EVENT_LOG);
    }
  }

  private resolveSetting(key: string): string | undefined {
    const fromRuntime = this.runtime.getSetting?.(key);
    if (typeof fromRuntime === "string" && fromRuntime.trim()) return fromRuntime.trim();
    const fromEnv = process.env[key];
    if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
    return undefined;
  }

  private resolveInt(key: string, fallback: number): number {
    const raw = this.resolveSetting(key);
    if (!raw) return fallback;
    const num = parseInt(raw, 10);
    return Number.isFinite(num) ? num : fallback;
  }

  private log(message: string): void {
    console.log(`[2004scape] ${message}`);
  }
}
