/**
 * TickTracer - captures inputs/outputs at every DAG node during a game tick.
 *
 * Singleton-per-tick using the same global pattern as tokenStatsService.
 * All calls are null-safe: getActiveTracer() returns null when tracing is disabled.
 */

import { logger } from "@feed/shared";
import { GAME_TICK_DAG } from "./dag-definition";
import type {
  LLMCallInput,
  LLMCallTrace,
  NodeTrace,
  NPCDecision,
  NPCGroupMessage,
  NPCPost,
  NPCTickTrajectory,
  NPCTrade,
  SubOperation,
  TickTrace,
  TokenStatsSummary,
} from "./types";

let activeTracer: TickTracer | null = null;

export function startTrace(tickId: string, tickNumber: number): void {
  activeTracer = new TickTracer(tickId, tickNumber);
}

export function getActiveTracer(): TickTracer | null {
  return activeTracer;
}

export function endTrace(): TickTrace | null {
  if (!activeTracer) return null;
  const trace = activeTracer.finalize();
  activeTracer = null;
  return trace;
}

export class TickTracer {
  private readonly tickId: string;
  private readonly tickNumber: number;
  private readonly startMs: number;
  private readonly nodes: Map<string, NodeTrace> = new Map();
  private readonly llmCalls: LLMCallTrace[] = [];
  private currentNodeId: string | null = null;
  private llmCallCounter = 0;
  private tokenStats: TokenStatsSummary = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
    byPromptType: {},
  };

  // NPC trajectory accumulators
  private readonly npcDecisions: Map<string, NPCDecision[]> = new Map();
  private readonly npcTrades: Map<string, NPCTrade[]> = new Map();
  private readonly npcPosts: Map<string, NPCPost[]> = new Map();
  private readonly npcGroupMessages: Map<string, NPCGroupMessage[]> = new Map();
  private readonly npcNames: Map<string, string> = new Map();

  private gameTickResult: Record<string, unknown> = {};
  private envFlags: Record<string, string | boolean> = {};

  constructor(tickId: string, tickNumber: number) {
    this.tickId = tickId;
    this.tickNumber = tickNumber;
    this.startMs = Date.now();
  }

  getCurrentNodeId(): string | null {
    return this.currentNodeId;
  }

  startNode(nodeId: string, inputs: Record<string, unknown> = {}): void {
    const dagNode = GAME_TICK_DAG.nodes.find((n) => n.id === nodeId);
    this.currentNodeId = nodeId;

    this.nodes.set(nodeId, {
      nodeId,
      name: dagNode?.name ?? nodeId,
      phase: dagNode?.phase ?? "Unknown",
      phaseNumber: dagNode?.phaseNumber ?? 0,
      startMs: Date.now(),
      endMs: 0,
      durationMs: 0,
      status: "success",
      inputs: this.safeSerialize(inputs),
      outputs: {},
      llmCallIds: [],
    });
  }

  endNode(nodeId: string, outputs: Record<string, unknown> = {}): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.endMs = Date.now();
    node.durationMs = node.endMs - node.startMs;
    node.outputs = this.safeSerialize(outputs);
    node.status = "success";

    if (this.currentNodeId === nodeId) {
      this.currentNodeId = null;
    }
  }

  skipNode(nodeId: string, reason?: string): void {
    const dagNode = GAME_TICK_DAG.nodes.find((n) => n.id === nodeId);
    this.nodes.set(nodeId, {
      nodeId,
      name: dagNode?.name ?? nodeId,
      phase: dagNode?.phase ?? "Unknown",
      phaseNumber: dagNode?.phaseNumber ?? 0,
      startMs: Date.now(),
      endMs: Date.now(),
      durationMs: 0,
      status: "skipped",
      inputs: {},
      outputs: {},
      error: reason,
      llmCallIds: [],
    });
  }

  /**
   * Mark a node as delegated to an external process (e.g., npc-tick).
   * Unlike skipNode, this indicates the work WAS done, just not in this process.
   */
  delegateNode(
    nodeId: string,
    source: string,
    data: Record<string, unknown> = {},
  ): void {
    const dagNode = GAME_TICK_DAG.nodes.find((n) => n.id === nodeId);
    this.nodes.set(nodeId, {
      nodeId,
      name: dagNode?.name ?? nodeId,
      phase: dagNode?.phase ?? "Unknown",
      phaseNumber: dagNode?.phaseNumber ?? 0,
      startMs: Date.now(),
      endMs: Date.now(),
      durationMs: 0,
      status: "delegated",
      inputs: { delegatedTo: source },
      outputs: this.safeSerialize(data),
      llmCallIds: [],
    });
  }

  failNode(nodeId: string, error: unknown): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.endMs = Date.now();
      node.durationMs = node.endMs - node.startMs;
      node.status = "error";
      node.error = error instanceof Error ? error.message : String(error);
    }
    if (this.currentNodeId === nodeId) {
      this.currentNodeId = null;
    }
  }

  /**
   * Record an LLM call. Uses explicit nodeId if provided, falls back to currentNodeId.
   */
  recordLLMCall(call: LLMCallInput, explicitNodeId?: string): string {
    this.llmCallCounter++;
    const callId = `call-${String(this.llmCallCounter).padStart(3, "0")}-${call.promptType}`;
    const nodeId =
      explicitNodeId ?? call.nodeId ?? this.currentNodeId ?? "unknown";

    const trace: LLMCallTrace = {
      callId,
      nodeId,
      timestamp: Date.now(),
      provider: call.provider,
      model: call.model,
      promptType: call.promptType,
      format: call.format,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      systemPrompt: call.systemPrompt,
      userPrompt: call.userPrompt,
      rawResponse: call.rawResponse,
      parsedResponse: call.parsedResponse,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      totalTokens: call.totalTokens,
      durationMs: call.durationMs,
      success: call.success,
      error: call.error,
    };

    this.llmCalls.push(trace);

    // Associate with node
    const node = this.nodes.get(nodeId);
    if (node) {
      node.llmCallIds.push(callId);
    }

    // Update token stats
    this.tokenStats.totalCalls++;
    this.tokenStats.totalInputTokens += call.inputTokens;
    this.tokenStats.totalOutputTokens += call.outputTokens;
    this.tokenStats.totalTokens += call.totalTokens;

    const pt = this.tokenStats.byPromptType[call.promptType] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    pt.calls++;
    pt.inputTokens += call.inputTokens;
    pt.outputTokens += call.outputTokens;
    this.tokenStats.byPromptType[call.promptType] = pt;

    return callId;
  }

  /**
   * Record a sub-operation within a node (DB write, internal LLM call, etc.)
   */
  recordSubOperation(nodeId: string, op: SubOperation): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (!node.subOperations) node.subOperations = [];
    node.subOperations.push(op);
  }

  // --- NPC trajectory recording ---

  recordNPCDecision(
    npcId: string,
    npcName: string,
    decision: NPCDecision,
  ): void {
    this.npcNames.set(npcId, npcName);
    const arr = this.npcDecisions.get(npcId) ?? [];
    arr.push({ timestamp: Date.now(), ...decision });
    this.npcDecisions.set(npcId, arr);
  }

  recordNPCTrade(npcId: string, npcName: string, trade: NPCTrade): void {
    this.npcNames.set(npcId, npcName);
    const arr = this.npcTrades.get(npcId) ?? [];
    arr.push({ timestamp: Date.now(), ...trade });
    this.npcTrades.set(npcId, arr);
  }

  recordNPCPost(npcId: string, npcName: string, post: NPCPost): void {
    this.npcNames.set(npcId, npcName);
    const arr = this.npcPosts.get(npcId) ?? [];
    arr.push({ timestamp: Date.now(), ...post });
    this.npcPosts.set(npcId, arr);
  }

  recordNPCGroupMessage(
    npcId: string,
    npcName: string,
    msg: NPCGroupMessage,
  ): void {
    this.npcNames.set(npcId, npcName);
    const arr = this.npcGroupMessages.get(npcId) ?? [];
    arr.push({ timestamp: Date.now(), ...msg });
    this.npcGroupMessages.set(npcId, arr);
  }

  setGameTickResult(result: Record<string, unknown>): void {
    this.gameTickResult = this.safeSerialize(result);
  }

  setTokenStats(stats: TokenStatsSummary): void {
    // Merge official stats for top-level numbers, but preserve LLM-call-derived byPromptType
    this.tokenStats = {
      ...this.tokenStats,
      totalCalls: stats.totalCalls ?? this.tokenStats.totalCalls,
      totalInputTokens:
        stats.totalInputTokens ?? this.tokenStats.totalInputTokens,
      totalOutputTokens:
        stats.totalOutputTokens ?? this.tokenStats.totalOutputTokens,
      totalTokens: stats.totalTokens ?? this.tokenStats.totalTokens,
      estimatedCostUSD:
        stats.estimatedCostUSD ?? this.tokenStats.estimatedCostUSD,
      // Keep the per-call-accumulated byPromptType — don't overwrite with empty object
      byPromptType:
        Object.keys(this.tokenStats.byPromptType).length > 0
          ? this.tokenStats.byPromptType
          : stats.byPromptType,
    };
  }

  setEnvironmentFlags(flags: Record<string, string | boolean>): void {
    this.envFlags = flags;
  }

  finalize(): TickTrace {
    const endMs = Date.now();

    // Build NPC trajectories
    const allNpcIds = new Set([
      ...this.npcDecisions.keys(),
      ...this.npcTrades.keys(),
      ...this.npcPosts.keys(),
      ...this.npcGroupMessages.keys(),
    ]);

    const npcTrajectories: NPCTickTrajectory[] = [];
    for (const npcId of allNpcIds) {
      npcTrajectories.push({
        npcId,
        npcName: this.npcNames.get(npcId) ?? npcId,
        decisions: this.npcDecisions.get(npcId) ?? [],
        trades: this.npcTrades.get(npcId) ?? [],
        posts: this.npcPosts.get(npcId) ?? [],
        groupMessages: this.npcGroupMessages.get(npcId) ?? [],
      });
    }

    return {
      tickId: this.tickId,
      tickNumber: this.tickNumber,
      timestamp: new Date(this.startMs).toISOString(),
      startMs: this.startMs,
      endMs,
      durationMs: endMs - this.startMs,
      dag: GAME_TICK_DAG,
      nodes: [...this.nodes.values()],
      llmCalls: this.llmCalls,
      npcTrajectories,
      tokenStats: this.tokenStats,
      gameTickResult: this.gameTickResult,
      environmentFlags:
        Object.keys(this.envFlags).length > 0 ? this.envFlags : undefined,
    };
  }

  /**
   * Safe serialization - handles circular refs, BigInts, Errors, and truncates large strings.
   * Tracks truncated keys for visibility.
   */
  private safeSerialize(obj: Record<string, unknown>): Record<string, unknown> {
    const MAX_STRING_LENGTH = 50_000;
    const seen = new WeakSet();
    const truncatedKeys: Array<{ key: string; originalLength: number }> = [];

    const replacer = (key: string, value: unknown): unknown => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
        truncatedKeys.push({ key, originalLength: value.length });
        return (
          value.slice(0, MAX_STRING_LENGTH) +
          `... [truncated ${value.length - MAX_STRING_LENGTH} chars]`
        );
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    };

    try {
      const result = JSON.parse(JSON.stringify(obj, replacer));
      if (truncatedKeys.length > 0) {
        result._truncated = truncatedKeys;
      }
      return result;
    } catch (err) {
      logger.warn(
        "Failed to serialize trace data",
        err instanceof Error ? err : undefined,
        "DagTrace",
      );
      return { _serializationError: true };
    }
  }
}
