import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  Service,
  setTrajectoryPurpose,
  type State,
  type TextGenerationModelType,
  withStandaloneTrajectory,
} from "@elizaos/core";
import {
  formatRs2004RouterPrompt,
  resolveRs2004RouterAction,
} from "./autonomous-loop-prompt.js";
import { type GatewayHandle, startGateway } from "../gateway/index.js";
import { botStateProvider } from "../providers/bot-state.js";
import { goalsProvider } from "../providers/goals.js";
import { mapAreaProvider } from "../providers/map-area.js";
import { worldKnowledgeProvider } from "../providers/world-knowledge.js";
import { BotActions } from "../sdk/actions.js";
import type { ActionResult, BotState, EventLogEntry } from "../sdk/types.js";
import { setCurrentLlmResponse } from "../shared-state.js";
import { BotManager } from "./bot-manager.js";

const DEFAULT_GATEWAY_PORT = 18791;
const DEFAULT_LOOP_INTERVAL_MS = 15_000;
const MAX_EVENT_LOG = 30;

/** Map user-facing size names to ModelType constants. */
const MODEL_SIZE_MAP: Record<string, TextGenerationModelType> = {
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
  private modelSize: TextGenerationModelType = DEFAULT_MODEL_SIZE;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new RsSdkGameService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    const gatewayPort = this.resolveInt(
      "RS_2004SCAPE_GATEWAY_PORT",
      DEFAULT_GATEWAY_PORT,
    );
    const loopInterval = this.resolveInt(
      "RS_2004SCAPE_LOOP_INTERVAL_MS",
      DEFAULT_LOOP_INTERVAL_MS,
    );
    const username =
      this.resolveSetting("RS_SDK_BOT_NAME") ??
      this.resolveSetting("BOT_NAME") ??
      "";
    const password =
      this.resolveSetting("RS_SDK_BOT_PASSWORD") ??
      this.resolveSetting("BOT_PASSWORD") ??
      "";
    const gatewayUrl =
      this.resolveSetting("RS_SDK_GATEWAY_URL") ??
      `ws://localhost:${gatewayPort}`;

    // Configurable model size: TEXT_NANO, TEXT_SMALL (default), TEXT_MEDIUM, TEXT_LARGE, etc.
    const sizeRaw = (
      this.resolveSetting("RS_2004SCAPE_MODEL_SIZE") ?? ""
    ).toUpperCase();
    this.modelSize = MODEL_SIZE_MAP[sizeRaw] ?? DEFAULT_MODEL_SIZE;
    this.log(`Model size: ${this.modelSize}`);

    if (!username) {
      this.log(
        "No RS_SDK_BOT_NAME configured — game service will not auto-connect.",
      );
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
      this.log(
        `Gateway failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Connect SDK to gateway
    this.botManager = new BotManager(gatewayUrl, username, password);
    try {
      this.botManager.connect();
      this.log(`SDK connecting as ${username}`);
    } catch (err) {
      this.log(
        `SDK connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      return {
        success: false,
        action: actionType,
        message: "Bot actions not initialized.",
      };
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

      const turn = this.stepNumber + 1;
      const agentId = this.runtime.agentId;

      await withStandaloneTrajectory(
        this.runtime,
        {
          source: "2004scape-autonomous-loop",
          metadata: {
            turn,
            agentId,
            modelSize: this.modelSize,
          },
        },
        async () => {
          this.stepNumber++;

          // 1. Gather provider context
          const providerContext = await this.gatherProviderContext();

          // 2. Build the full prompt
          const prompt = this.buildPrompt(botState, providerContext);

          // 3. Call the LLM with the configured model size
          setTrajectoryPurpose("background");
          this.log(`Step ${this.stepNumber} - calling ${this.modelSize}`);
          const response = await this.runtime.useModel(this.modelSize, {
            prompt,
            maxTokens: 400,
          });

          if (
            !response ||
            typeof response !== "string" ||
            response.trim().length === 0
          ) {
            this.log(`Step ${this.stepNumber} - empty LLM response`);
            return;
          }

          this.log(`Step ${this.stepNumber} - LLM: ${response.slice(0, 200)}`);

          // Store for action handlers that might read it
          setCurrentLlmResponse(response);

          // 4. Parse the chosen action from the response
          const parsed = this.parseActionFromResponse(response);
          if (!parsed) {
            this.log(
              `Step ${this.stepNumber} - could not parse action from response`,
            );
            return;
          }

          // 5. Execute the action
          this.log(`Step ${this.stepNumber} - executing ${parsed.actionType}`);
          const result = await this.executeAction(
            parsed.actionType,
            parsed.params,
          );
          this.log(
            `Step ${this.stepNumber} - ${result.action}: ${result.success ? "OK" : "FAIL"} - ${result.message}`,
          );
        },
      );
    } catch (err) {
      this.log(
        `Step ${this.stepNumber} error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.loopRunning = false;
    }
  }

  private async gatherProviderContext(): Promise<string> {
    const dummyMemory = {
      content: { text: "" },
    } as Memory;
    const dummyState = {
      values: {},
      data: {},
      text: "",
    } as State;
    const sections: string[] = [];

    try {
      sections.push(
        (await mapAreaProvider.get(this.runtime, dummyMemory, dummyState))
          .text ?? "",
      );
    } catch {
      /* provider optional */
    }
    try {
      sections.push(
        (
          await worldKnowledgeProvider.get(
            this.runtime,
            dummyMemory,
            dummyState,
          )
        ).text ?? "",
      );
    } catch {
      /* provider optional */
    }
    try {
      sections.push(
        (await goalsProvider.get(this.runtime, dummyMemory, dummyState)).text ??
          "",
      );
    } catch {
      /* provider optional */
    }
    try {
      sections.push(
        (await botStateProvider.get(this.runtime, dummyMemory, dummyState))
          .text ?? "",
      );
    } catch {
      /* provider optional */
    }

    return sections.filter(Boolean).join("\n\n");
  }

  private buildPrompt(state: BotState, providerContext: string): string {
    const p = state.player!;

    const recentActions = this.eventLog
      .slice(-8)
      .map(
        (e) =>
          `  [${e.result.success ? "OK" : "FAIL"}] ${e.action}: ${e.result.message}`,
      )
      .join("\n");

    const actionListStr = formatRs2004RouterPrompt();

    return `You are an autonomous RuneScape bot playing 2004scape. Step ${this.stepNumber}.
Your name: ${p.name} | Combat: ${p.combatLevel} | HP: ${p.hp}/${p.maxHp} | Position: (${p.worldX}, ${p.worldZ}) | Inventory: ${state.inventory.length}/28

${providerContext}

# Action History (recent)
${recentActions || "  (none yet)"}

# Available Actions
Choose exactly ONE action. Return only JSON:
{
  "action": "ROUTER_NAME",
  "subaction": "router_operation",
  "param_name": "value"
}
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
    const parsed = parseJSONObjectFromText(response) as Record<string, unknown> | null;
    const action = this.extractActionName(parsed);
    if (!action) return null;

    // Solo movement action: not a router, dispatched directly.
    if (action === "RS_2004_WALK_TO") {
      const params = this.extractParamsFromParsedResponse(parsed);
      this.mapParamAliases("walkTo", params);
      return { actionType: "walkTo", params };
    }

    const resolved = resolveRs2004RouterAction(
      action,
      this.extractSubactionName(parsed),
    );
    if (!resolved) return null;
    const params = this.extractParamsFromParsedResponse(parsed);
    this.mapParamAliases(resolved.dispatch, params);
    return { actionType: resolved.dispatch, params };
  }

  private extractActionName(
    parsed: Record<string, unknown> | null,
  ): string | null {
    const raw =
      parsed?.action ?? parsed?.actionName ?? parsed?.name ?? parsed?.type;
    if (typeof raw !== "string") return null;
    return (
      raw
        .trim()
        .replace(/[\s-]+/g, "_")
        .toUpperCase() || null
    );
  }

  private extractSubactionName(
    parsed: Record<string, unknown> | null,
  ): string | null {
    const raw =
      parsed?.subaction ??
      parsed?.op ??
      parsed?.skill ??
      parsed?.operation ??
      parsed?.intent;
    if (typeof raw !== "string") return null;
    return raw.trim().toLowerCase() || null;
  }

  private extractParamsFromParsedResponse(
    parsed: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!parsed) return {};
    const params: Record<string, unknown> = {};
    const nestedParams =
      parsed.params &&
      typeof parsed.params === "object" &&
      !Array.isArray(parsed.params)
        ? (parsed.params as Record<string, unknown>)
        : null;
    const source = nestedParams ?? parsed;

    for (const [key, value] of Object.entries(source)) {
      if (
        [
          "action",
          "actionName",
          "name",
          "type",
          "params",
          "subaction",
          "op",
          "skill",
          "operation",
          "intent",
        ].includes(key)
      ) {
        continue;
      }
      params[key] = this.coerceParamValue(value);
    }

    return params;
  }

  private coerceParamValue(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    if (/^(true|false)$/i.test(trimmed))
      return trimmed.toLowerCase() === "true";
    return trimmed;
  }

  /** Normalize param names from model output to dispatchAction expectations. */
  private mapParamAliases(
    actionType: string,
    params: Record<string, unknown>,
  ): void {
    // Bare aliases — generic name used by the *_OP routers.
    if (params.npc && !params.npcName) params.npcName = params.npc;
    if (params.item && !params.itemName) params.itemName = params.item;
    if (params.object && !params.objectName) params.objectName = params.object;
    if (params.tree && !params.treeName) params.treeName = params.tree;
    if (params.rock && !params.rockName) params.rockName = params.rock;
    if (params.spot && !params.spotName) params.spotName = params.spot;
    if (params.food && !params.rawFoodName) params.rawFoodName = params.food;
    if (params.spell && !params.spellId) params.spellId = params.spell;
    if (params.item1 && !params.itemName1) params.itemName1 = params.item1;
    if (params.item2 && !params.itemName2) params.itemName2 = params.item2;

    // Generic `target` field — meaning depends on the dispatched action.
    if (params.target != null) {
      switch (actionType) {
        case "chopTree":
          params.treeName ??= params.target;
          break;
        case "mineRock":
          params.rockName ??= params.target;
          break;
        case "fish":
          params.spotName ??= params.target;
          break;
        case "cookFood":
          params.rawFoodName ??= params.target;
          break;
        case "smithAtAnvil":
          params.itemName ??= params.target;
          break;
        case "attackNpc":
          params.npcName ??= params.target;
          break;
        case "castSpell":
          params.targetNid ??= params.target;
          break;
        case "useItemOnItem":
          params.itemName2 ??= params.target;
          break;
        case "useItemOnObject":
          params.objectName ??= params.target;
          break;
      }
    }

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
        return actions.walkTo(
          num("x", 0),
          num("z", 0),
          str("reason") || undefined,
        );
      }
      case "openDoor":
        return actions.openDoor();
      case "talkToNpc":
        return actions.talkToNpc(str("npcName"));
      case "navigateDialog":
        return actions.navigateDialog(num("option", 1));
      case "interactObject":
        return actions.interactObject(
          str("objectName"),
          str("option") || undefined,
        );
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
        return {
          success: false,
          action: actionType,
          message: `Unknown action: ${actionType}`,
        };
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
    if (typeof fromRuntime === "string" && fromRuntime.trim())
      return fromRuntime.trim();
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
