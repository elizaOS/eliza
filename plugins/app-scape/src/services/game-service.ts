/**
 * ScapeGameService — the elizaOS Service that owns the agent's
 * connection lifecycle and (eventually) the LLM game loop.
 *
 * PR 3 scope: on `initialize()` the service reads env / runtime
 * settings, builds a {@link BotManager}, and connects. That triggers
 * the full login flow on the xRSPS side — scrypt verify, persistence
 * restore, AgentComponent attach, tick loop inclusion. After that the
 * service passively caches perception snapshots so callers can read
 * `getPerception()` / `isConnected()`.
 *
 * The LLM loop (step every N ms, build prompt from providers, parse
 * action, dispatch) lands in PR 4. Until then `ScapeGameService` is
 * a connection-manager Service with a public action-dispatch method.
 *
 * Safety rail: if `SCAPE_BOT_SDK_TOKEN` or `SCAPE_AGENT_PASSWORD` is
 * unset, `initialize()` logs a warning and returns without connecting.
 * This matches the xRSPS side, which disables the bot-SDK endpoint
 * unless `BOT_SDK_TOKEN` is set. Nothing happens silently.
 */

import {
  type IAgentRuntime,
  ModelType,
  parseJSONObjectFromText,
  Service,
  setTrajectoryPurpose,
  withStandaloneTrajectory,
} from "@elizaos/core";

import {
  formatScapeRouterPrompt,
  resolveScapeRouterAction,
} from "../actions/router-definitions.js";
import { botStateProvider } from "../providers/bot-state.js";
import { goalsProvider } from "../providers/goals.js";
import { inventoryProvider } from "../providers/inventory.js";
import { journalProvider } from "../providers/journal.js";
import { nearbyProvider } from "../providers/nearby.js";
import type { SdkConnectionStatus } from "../sdk/index.js";
import type {
  ActionFramePayload,
  PerceptionSnapshot,
  SpawnOkFrame,
} from "../sdk/types.js";
import { setCurrentLlmResponse } from "../shared-state.js";
import { loadOrGenerateAgentIdentity } from "./agent-identity.js";
import { BotManager, type BotManagerConfig } from "./bot-manager.js";
import { JournalService } from "./journal-service.js";

/**
 * Default URL for the xRSPS bot-SDK endpoint. Points at the live
 * production deployment on Sevalla — the same HTTP server that
 * serves the main game WebSocket routes /botsdk upgrades into
 * the bot-SDK JSON endpoint. TLS is terminated by Sevalla's
 * ingress, so the URL is wss:// and no insecure opt-in is needed.
 *
 * Override via SCAPE_BOT_SDK_URL character secret or process env
 * to target a local dev xRSPS instance, e.g.
 *   ws://127.0.0.1:8080/botsdk   (shared-HTTP topology)
 */
const DEFAULT_BOT_SDK_URL = "wss://scape-96cxt.sevalla.app/botsdk";
const _DEFAULT_AGENT_NAME = "scape-agent";
const DEFAULT_CONTROLLER: "hybrid" = "hybrid";
const DEFAULT_LOOP_INTERVAL_MS = 15_000;
const MAX_EVENT_LOG = 12;

type ScapeModelSize =
  | typeof ModelType.TEXT_NANO
  | typeof ModelType.TEXT_SMALL
  | typeof ModelType.TEXT_MEDIUM
  | typeof ModelType.TEXT_LARGE;

const MODEL_SIZE_MAP: Record<string, ScapeModelSize> = {
  TEXT_NANO: ModelType.TEXT_NANO,
  TEXT_SMALL: ModelType.TEXT_SMALL,
  TEXT_MEDIUM: ModelType.TEXT_MEDIUM,
  TEXT_LARGE: ModelType.TEXT_LARGE,
  NANO: ModelType.TEXT_NANO,
  SMALL: ModelType.TEXT_SMALL,
  MEDIUM: ModelType.TEXT_MEDIUM,
  LARGE: ModelType.TEXT_LARGE,
};

interface EventLogEntry {
  stepNumber: number;
  action: string;
  success: boolean;
  message: string;
}

/**
 * Action names dispatched as standalone (not via JOURNAL_OP / INVENTORY_OP).
 * The autonomous loop's parser treats these as `actionName === subaction` so
 * the dispatcher's switch can branch on a single label.
 */
const STANDALONE_ACTION_NAMES: ReadonlySet<string> = new Set([
  "WALK_TO",
  "ATTACK_NPC",
  "CHAT_PUBLIC",
]);

function resolveSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const fromRuntime = runtime.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

/**
 * The elizaOS Service contract allows either a class with
 * `static async start(runtime)` or an already-instantiated object.
 * 2004scape uses the static-start pattern — we mirror it so the
 * eliza runtime loads us the same way.
 */
export class ScapeGameService extends Service {
  static readonly serviceType = "scape_game";

  readonly capabilityDescription =
    "'scape autonomous game agent — connects to the xRSPS bot-SDK endpoint as a first-class account, caches perception snapshots, and exposes the action dispatch surface the LLM loop uses.";

  private botManager: BotManager | null = null;
  private journalService: JournalService | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private loopRunning = false;
  private stepNumber = 0;
  private stopped = false;
  private modelSize: ScapeModelSize = ModelType.TEXT_SMALL;
  private loopIntervalMs = DEFAULT_LOOP_INTERVAL_MS;
  private eventLog: EventLogEntry[] = [];
  private operatorGoal = "";
  private immediateStepPending = false;
  /** Operator has explicitly paused the autonomous loop via the
   *  `/session/:id/control` route. Takes precedence over connection
   *  status — pause survives reconnects so the operator stays in
   *  control. */
  private pausedByOperator = false;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new ScapeGameService(runtime);
    await service.initialize();
    return service;
  }

  /**
   * Boot the service. Called exactly once by `start`. Reads the
   * config, instantiates the BotManager, and (if everything is set)
   * kicks off the connection to xRSPS.
   */
  async initialize(): Promise<void> {
    this.log("initializing");

    const url =
      resolveSetting(this.runtime, "SCAPE_BOT_SDK_URL") ?? DEFAULT_BOT_SDK_URL;
    const token = resolveSetting(this.runtime, "SCAPE_BOT_SDK_TOKEN");
    const persona = resolveSetting(this.runtime, "SCAPE_AGENT_PERSONA");

    // Autonomous loop tuning.
    const rawInterval = resolveSetting(this.runtime, "SCAPE_LOOP_INTERVAL_MS");
    if (rawInterval) {
      const parsed = parseInt(rawInterval, 10);
      if (Number.isFinite(parsed) && parsed >= 1000)
        this.loopIntervalMs = parsed;
    }
    const rawModel = (
      resolveSetting(this.runtime, "SCAPE_MODEL_SIZE") ?? ""
    ).toUpperCase();
    this.modelSize = MODEL_SIZE_MAP[rawModel] ?? ModelType.TEXT_SMALL;

    if (!token) {
      this.log(
        "SCAPE_BOT_SDK_TOKEN not set — plugin will not connect. Set it to match xRSPS BOT_SDK_TOKEN.",
      );
      return;
    }

    // Resolve the agent's account credentials. Priority order:
    //   1. Explicit runtime settings (SCAPE_AGENT_NAME / _PASSWORD / _ID)
    //   2. Persisted identity file at ~/.eliza/scape-agent-identity.json
    //   3. Freshly generated + persisted (zero-friction first-run UX)
    //
    // Self-generation is the important change here: the operator
    // no longer has to set any secrets for the plugin to work —
    // first launch creates an identity, every subsequent launch
    // reuses it, and the agent's xRSPS account (skills, inventory,
    // position, journal) accumulates across sessions as the
    // *same* character.
    const identity = loadOrGenerateAgentIdentity({
      overrides: {
        displayName: resolveSetting(this.runtime, "SCAPE_AGENT_NAME"),
        password: resolveSetting(this.runtime, "SCAPE_AGENT_PASSWORD"),
        agentId: resolveSetting(this.runtime, "SCAPE_AGENT_ID"),
      },
      log: (line) => this.log(line),
    });
    const displayName = identity.displayName;
    const password = identity.password;
    const agentId = identity.agentId;

    const config: BotManagerConfig = {
      url,
      token,
      agentId,
      displayName,
      password,
      controller: DEFAULT_CONTROLLER,
      persona,
    };

    // Boot the Scape Journal so the first perception has
    // somewhere to land. The store auto-creates the file on
    // first spawn.
    this.journalService = new JournalService({
      agentId,
      displayName,
      log: (line) => this.log(line),
    });

    this.botManager = new BotManager(config, {
      onStatusChange: (status) => this.onStatusChange(status),
      onSpawn: (spawn) => this.onSpawn(spawn),
      onPerception: (snapshot) => this.onPerception(snapshot),
      onServerError: (error) => {
        this.log(`server error ${error.code}: ${error.message}`);
      },
      onOperatorCommand: (frame) => {
        // `::steer <text>` from an in-game chat message, or
        // any future admin path. Route to the same operator
        // goal buffer the POST /prompt endpoint writes to.
        const source = frame.fromPlayerName ?? frame.source ?? "operator";
        this.log(
          `operator steering from ${source}: "${frame.text.slice(0, 80)}"`,
        );
        this.setOperatorGoal(frame.text);
      },
      onLog: (line) => this.log(line),
    });

    this.botManager.connect();
    this.log(`connecting to ${url} as "${displayName}" (agentId=${agentId})`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.botManager?.disconnect("service_stop");
    this.botManager = null;
    this.log("stopped");
  }

  // ─── Public API (used by actions/providers in PR 4+) ────────────

  isConnected(): boolean {
    return this.botManager?.isConnected() ?? false;
  }

  getStatus(): SdkConnectionStatus {
    return this.botManager?.getStatus() ?? "idle";
  }

  getPerception(): PerceptionSnapshot | null {
    return this.botManager?.getPerception() ?? null;
  }

  getSpawnState(): SpawnOkFrame | null {
    return this.botManager?.getSpawnState() ?? null;
  }

  async executeAction(
    action: ActionFramePayload,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.botManager) {
      return { success: false, message: "not connected" };
    }
    return this.botManager.sendAction(action);
  }

  /**
   * Public accessor for the Scape Journal. Actions + providers
   * reach the journal through this getter so the service is the
   * single owner and there's no risk of multiple stores pointing
   * at the same file concurrently.
   */
  getJournalService(): JournalService | null {
    return this.journalService;
  }

  /**
   * Set the current operator goal — used by PR 7's POST /prompt
   * handler and in-game /steer chat command. Exported now so the
   * journal service can attach a memory for it.
   */
  setOperatorGoal(goal: string): void {
    this.operatorGoal = goal.trim();
    if (this.operatorGoal.length > 0 && this.journalService) {
      this.journalService.setGoal({
        title: this.operatorGoal,
        source: "operator",
      });
    }
  }

  getOperatorGoal(): string {
    return this.operatorGoal;
  }

  /**
   * Expose the recent event log for operator surfaces. The log is a
   * bounded in-memory ring of step outcomes the autonomous loop has
   * recorded via `pushEventLog`. The newest entries are at the end;
   * callers generally want them reversed for display.
   */
  getRecentEventLog(limit = 16): EventLogEntry[] {
    if (limit <= 0) return [];
    return this.eventLog.slice(-limit);
  }

  /**
   * Apply an operator message coming through the session-scoped
   * route `/api/apps/scape/session/:id/message`. This is the path
   * the eliza Apps UI uses for run-steering. We recognize a couple
   * of inline control verbs (`pause` / `resume`) and otherwise
   * treat the whole text as an operator goal.
   */
  applyOperatorMessage(raw: string): {
    disposition: "queued" | "accepted";
    note: string;
  } {
    const text = raw.trim();
    if (/^(pause|pause autoplay|pause session)$/i.test(text)) {
      this.pause();
      return {
        disposition: "accepted",
        note: "autoplay paused by operator",
      };
    }
    if (/^(resume|resume autoplay|resume session)$/i.test(text)) {
      this.resume();
      return {
        disposition: "accepted",
        note: "autoplay resumed by operator",
      };
    }
    this.setOperatorGoal(text);
    return {
      disposition: "queued",
      note: "operator goal queued; next LLM step will prioritize it",
    };
  }

  /**
   * Pause the autonomous LLM loop. The bot-SDK connection stays
   * open so perception keeps updating and the operator can still
   * see what the agent is looking at, but no new steps run. Resume
   * with {@link resume}.
   */
  pause(): void {
    this.pausedByOperator = true;
    this.stopLoop();
    this.log("paused by operator");
  }

  /**
   * Resume the autonomous LLM loop after a {@link pause}. No-op if
   * we weren't paused.
   */
  resume(): void {
    if (!this.pausedByOperator) return;
    this.pausedByOperator = false;
    this.log("resumed by operator");
    // Only actually restart the loop if we're still connected —
    // otherwise let onStatusChange handle it when the connection
    // comes back up.
    if (this.botManager?.isConnected()) {
      this.startLoop();
    }
  }

  isPausedByOperator(): boolean {
    return this.pausedByOperator;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private onStatusChange(status: SdkConnectionStatus): void {
    if (this.stopped) return;
    if (status === "connected") {
      if (this.pausedByOperator) {
        this.log("reconnected while operator-paused; loop stays idle");
        return;
      }
      this.startLoop();
    } else if (
      status === "reconnecting" ||
      status === "closed" ||
      status === "failed"
    ) {
      this.stopLoop();
    }
  }

  // ─── Autonomous loop ────────────────────────────────────────────

  /**
   * Start the LLM step loop. Safe to call multiple times — a second
   * call is a no-op while the first is still running.
   *
   * We do NOT fire a step inline here, because `startLoop` is invoked
   * from `onStatusChange("connected")`, which runs before the first
   * perception frame arrives. An eager step would see `getPerception()
   * === null` and bail out, wasting the slot. Instead we set a
   * `pendingImmediateStep` flag and the perception handler fires the
   * first step as soon as it has data.
   */
  private startLoop(): void {
    if (this.loopTimer || this.stopped) return;
    this.log(
      `starting autonomous loop — interval=${this.loopIntervalMs}ms model=${this.modelSize}`,
    );
    this.loopTimer = setInterval(() => {
      void this.autonomousStep();
    }, this.loopIntervalMs);
    this.immediateStepPending = true;
  }

  private stopLoop(): void {
    if (!this.loopTimer) return;
    clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.log("autonomous loop stopped");
  }

  /**
   * One cycle of the autonomous agent loop:
   *   1. Bail if not connected / no perception yet.
   *   2. Gather provider context (JSON blocks).
   *   3. Ask the LLM what to do next.
   *   4. Parse the chosen action + params.
   *   5. Dispatch through the elizaOS Action handler (which calls
   *      `executeAction` back into this service).
   */
  private async autonomousStep(): Promise<void> {
    if (this.loopRunning || this.stopped) return;
    this.loopRunning = true;
    try {
      if (!this.botManager?.isConnected()) return;
      const snapshot = this.botManager.getPerception();
      if (!snapshot) return;

      await withStandaloneTrajectory(
        this.runtime,
        {
          source: "scape-autonomous-loop",
          metadata: {
            game: "scape",
            stepNumber: this.stepNumber + 1,
            modelSize: this.modelSize,
          },
        },
        async () => {
          this.stepNumber += 1;

          const providerContext = await this.gatherProviderContext();
          const prompt = this.buildPrompt(snapshot, providerContext);

          this.log(
            `step ${this.stepNumber} -> ${this.modelSize} (prompt=${prompt.length}ch)`,
          );

          let response: unknown;
          try {
            setTrajectoryPurpose("background");
            response = await this.runtime.useModel(this.modelSize, {
              prompt,
              maxTokens: 300,
            });
          } catch (err) {
            this.log(
              `step ${this.stepNumber} LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }

          if (typeof response !== "string" || response.trim().length === 0) {
            this.log(`step ${this.stepNumber} empty LLM response`);
            return;
          }

          this.log(`step ${this.stepNumber} LLM: ${response.slice(0, 200)}`);
          setCurrentLlmResponse(response);

          const parsed = this.parseActionFromResponse(response);
          if (!parsed) {
            this.pushEventLog(
              "UNKNOWN",
              false,
              "could not parse action from response",
            );
            this.log(`step ${this.stepNumber} parse miss`);
            return;
          }

          const actionLabel = `${parsed.actionName}.${parsed.subaction}`;
          this.log(`step ${this.stepNumber} dispatching ${actionLabel}`);
          const result = await this.dispatchFromLoop(parsed);
          this.pushEventLog(
            actionLabel,
            result.success,
            result.message ?? (result.success ? "ok" : "fail"),
          );
          this.log(
            `step ${this.stepNumber} ${actionLabel} -> ${result.success ? "OK" : "FAIL"}: ${result.message ?? ""}`,
          );
        },
      );
    } catch (err) {
      this.log(
        `step ${this.stepNumber} error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.loopRunning = false;
    }
  }

  private async gatherProviderContext(): Promise<string> {
    // Providers expect Memory + State shaped args. None of them
    // actually inspect the shape so a stub works; the cast keeps
    // the call site aligned with the elizaOS Provider contract
    // (runtime, message, state → ProviderResult).
    const dummyMemory = {
      content: { text: "" },
    } as unknown as import("@elizaos/core").Memory;
    const dummyState = {
      values: {},
      data: {},
      text: "",
    } as unknown as import("@elizaos/core").State;
    const sections: string[] = [];
    // Order matters for prompt readability: self / inventory
    // come first (short), nearby next (variable), then the
    // journal blocks (growing over the session) and goals last
    // so the LLM's attention lands on them when parsing the
    // action list underneath.
    const orderedProviders = [
      botStateProvider,
      inventoryProvider,
      nearbyProvider,
      journalProvider,
      goalsProvider,
    ];
    for (const provider of orderedProviders) {
      try {
        const result = await provider.get(
          this.runtime,
          dummyMemory,
          dummyState,
        );
        const text = result?.text ?? "";
        if (text.length > 0) {
          sections.push(text);
        }
      } catch {
        // Provider failure is non-fatal — skip the block.
      }
    }
    return sections.join("\n\n");
  }

  private buildPrompt(snapshot: PerceptionSnapshot, context: string): string {
    const self = snapshot.self;
    const eventLog =
      this.eventLog.length === 0
        ? "  (none yet)"
        : this.eventLog
            .slice(-6)
            .map(
              (e) =>
                `  [${e.success ? "OK" : "FAIL"}] ${e.action}: ${e.message}`,
            )
            .join("\n");

    const actionList = formatScapeRouterPrompt();

    const operatorBlock = this.operatorGoal
      ? `\n# OPERATOR COMMAND (highest priority)\n"${this.operatorGoal}"\nYou MUST work toward this goal.\n`
      : "";

    return `You are '${self.name}', an autonomous agent playing xRSPS (an OSRS-like MMORPG). Step ${this.stepNumber}.
Combat level: ${self.combatLevel} | HP: ${self.hp}/${self.maxHp} | Position: (${self.x}, ${self.z}) | Run energy: ${self.runEnergy} | In combat: ${self.inCombat}
${operatorBlock}
${context}

# Recent Actions
${eventLog}

# Available Actions
Choose exactly ONE action. Return only a JSON object:
{
  "action": "ROUTER_NAME",
  "subaction": "router_operation"
}
${actionList}

# Instructions
- Walk somewhere interesting. Explore. Don't stand still.
- SCAPE_GAME with subaction walk_to takes absolute world coordinates. Use your current position (${self.x}, ${self.z}) as a reference and pick a nearby tile to move toward.
- Do NOT repeat a failed action with the same params — try something different.
- Keep responses short. Pick ONE action and provide its params.

Your choice:`;
  }

  private parseActionFromResponse(response: string): {
    actionName: string;
    subaction: string;
    legacyAction: string;
    params: Record<string, unknown>;
  } | null {
    const parsed = parseJSONObjectFromText(response) as Record<string, unknown> | null;
    const action = this.extractActionName(parsed);
    if (!action) return null;

    const params = this.extractParamsFromParsedResponse(parsed);

    // Standalone actions: WALK_TO, ATTACK_NPC, CHAT_PUBLIC.
    if (STANDALONE_ACTION_NAMES.has(action)) {
      return {
        actionName: action,
        subaction: action.toLowerCase(),
        legacyAction: action,
        params,
      };
    }

    // Router actions: JOURNAL_OP, INVENTORY_OP.
    const resolved = resolveScapeRouterAction(
      action,
      this.extractSubactionName(parsed),
    );
    if (!resolved) return null;
    return {
      actionName: resolved.routerName,
      subaction: resolved.subaction,
      legacyAction: resolved.legacyAction,
      params,
    };
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
      parsed?.op ?? parsed?.subaction ?? parsed?.operation ?? parsed?.intent;
    if (typeof raw !== "string") return null;
    return (
      raw
        .trim()
        .replace(/[\s_]+/g, "-")
        .toLowerCase() || null
    );
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
          "op",
          "subaction",
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

  /**
   * Route a parsed LLM action through the bot-SDK. Each branch
   * produces a typed `AnyActionFrame` and hands it to
   * `executeAction`, which forwards to the BotManager / BotSdk.
   *
   * Param validation is intentionally lenient — the server is the
   * source of truth and returns structured error messages that get
   * logged back into the event history so the LLM can course-correct.
   */
  private async dispatchFromLoop(parsed: {
    actionName: string;
    subaction: string;
    params: Record<string, unknown>;
  }): Promise<{ success: boolean; message?: string }> {
    switch (parsed.subaction) {
      case "walk_to": {
        const x = Number(parsed.params.x);
        const z = Number(parsed.params.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          return { success: false, message: "missing x/z" };
        }
        const run = parsed.params.run === true || parsed.params.run === "true";
        return this.executeAction({ action: "walkTo", x, z, run });
      }
      case "chat_public": {
        const rawMessage = parsed.params.message ?? parsed.params.text ?? "";
        const text = String(rawMessage).trim();
        if (text.length === 0) {
          return { success: false, message: "missing message" };
        }
        return this.executeAction({ action: "chatPublic", text });
      }
      case "attack_npc": {
        const npcId = Number(parsed.params.npcId ?? parsed.params.id);
        if (!Number.isFinite(npcId)) {
          return { success: false, message: "missing npcId" };
        }
        return this.executeAction({ action: "attackNpc", npcId });
      }
      case "drop": {
        const slot = Number(parsed.params.item ?? parsed.params.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= 28) {
          return { success: false, message: "item must be slot 0..27" };
        }
        return this.executeAction({ action: "dropItem", slot });
      }
      case "eat": {
        const raw = parsed.params.item ?? parsed.params.slot;
        const slot =
          raw === undefined || raw === null ? undefined : Number(raw);
        if (
          slot !== undefined &&
          (!Number.isInteger(slot) || slot < 0 || slot >= 28)
        ) {
          return { success: false, message: "item must be slot 0..27" };
        }
        return this.executeAction({ action: "eatFood", slot });
      }
      case "set-goal": {
        const title = String(parsed.params.title ?? "").trim();
        if (!title) return { success: false, message: "missing title" };
        const notes = String(parsed.params.notes ?? "").trim() || undefined;
        const journal = this.journalService;
        if (!journal) return { success: false, message: "journal unavailable" };
        const goal = journal.setGoal({ title, notes, source: "agent" });
        return { success: true, message: `goal set: "${goal.title}"` };
      }
      case "complete-goal": {
        const journal = this.journalService;
        if (!journal) return { success: false, message: "journal unavailable" };
        const statusRaw = String(
          parsed.params.status ?? "completed",
        ).toLowerCase();
        if (statusRaw !== "completed" && statusRaw !== "abandoned") {
          return {
            success: false,
            message: "status must be completed|abandoned",
          };
        }
        const explicitId =
          parsed.params.goalId != null
            ? String(parsed.params.goalId)
            : parsed.params.id != null
              ? String(parsed.params.id)
              : undefined;
        const notes = String(parsed.params.notes ?? "").trim() || undefined;
        const goalId = explicitId ?? journal.getActiveGoal()?.id;
        if (!goalId) return { success: false, message: "no goal to close" };
        const updated = journal.markGoalStatus(
          goalId,
          statusRaw as "completed" | "abandoned",
          notes,
        );
        if (!updated)
          return { success: false, message: `goal ${goalId} not found` };
        return { success: true, message: `goal -> ${statusRaw}` };
      }
      case "remember": {
        const journal = this.journalService;
        if (!journal) return { success: false, message: "journal unavailable" };
        const text = String(
          parsed.params.notes ?? parsed.params.text ?? "",
        ).trim();
        if (!text) return { success: false, message: "missing notes" };
        const kind = String(parsed.params.kind ?? "note");
        const weightRaw = Number(parsed.params.weight ?? 2);
        const weight = Math.max(1, Math.min(5, Math.floor(weightRaw)));
        const snapshot = this.getPerception();
        journal.addMemory({
          kind,
          text: text.slice(0, 200),
          weight,
          x: snapshot?.self.x,
          z: snapshot?.self.z,
        });
        return { success: true, message: `journal: ${kind} recorded` };
      }
      default:
        return {
          success: false,
          message: `unknown subaction ${parsed.actionName}.${parsed.subaction}`,
        };
    }
  }

  private pushEventLog(
    action: string,
    success: boolean,
    message: string,
  ): void {
    this.eventLog.push({
      stepNumber: this.stepNumber,
      action,
      success,
      message,
    });
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog.shift();
    }
  }

  private onSpawn(spawn: SpawnOkFrame): void {
    this.log(
      `agent logged into xRSPS world as playerId=${spawn.playerId} at (${spawn.x}, ${spawn.z}) level=${spawn.level}`,
    );
    this.journalService?.onSpawn();
  }

  private onPerception(snapshot: PerceptionSnapshot): void {
    if (snapshot.tick % 30 === 0) {
      this.log(
        `perception tick=${snapshot.tick} pos=(${snapshot.self.x}, ${snapshot.self.z}) hp=${snapshot.self.hp}/${snapshot.self.maxHp}`,
      );
    }

    // Feed the snapshot to the journal so notable deltas
    // (damage, XP, level-ups) become searchable memories
    // before the next LLM step runs.
    this.journalService?.onPerception(snapshot);

    // Kick off the first autonomous step as soon as we have real
    // data to prompt the LLM with. After that the setInterval timer
    // takes over at the configured cadence.
    if (this.immediateStepPending && !this.loopRunning && !this.stopped) {
      this.immediateStepPending = false;
      void this.autonomousStep();
    }
  }

  private log(line: string): void {
    console.log(`[scape] ${line}`);
  }
}
