/**
 * Context Test Script
 *
 * Sends "hello, how are you?" to an agent and logs the full model
 * inputs (system prompt, user prompt) and outputs (response) via the
 * built-in TrajectoryLoggerService. This lets you inspect exactly what
 * context the agent sees by default.
 *
 * Usage:
 *   bun run scripts/context-test.ts
 */

import "dotenv/config";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  type UUID,
  type Plugin,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// LLM provider detection (same as chat example)
// ---------------------------------------------------------------------------

interface LLMProvider {
  name: string;
  envKey: string;
  importPath: string;
  exportName: string;
}

const LLM_PROVIDERS: LLMProvider[] = [
  { name: "OpenAI", envKey: "OPENAI_API_KEY", importPath: "@elizaos/plugin-openai", exportName: "openaiPlugin" },
  { name: "Anthropic", envKey: "ANTHROPIC_API_KEY", importPath: "@elizaos/plugin-anthropic", exportName: "anthropicPlugin" },
  { name: "xAI", envKey: "XAI_API_KEY", importPath: "@elizaos/plugin-xai", exportName: "xaiPlugin" },
  { name: "Google GenAI", envKey: "GOOGLE_GENERATIVE_AI_API_KEY", importPath: "@elizaos/plugin-google-genai", exportName: "googleGenaiPlugin" },
  { name: "Groq", envKey: "GROQ_API_KEY", importPath: "@elizaos/plugin-groq", exportName: "groqPlugin" },
];

async function loadLLMPlugin(): Promise<{ plugin: Plugin; providerName: string } | null> {
  for (const p of LLM_PROVIDERS) {
    const val = process.env[p.envKey];
    if (typeof val === "string" && val.trim().length > 0) {
      try {
        const mod = await import(p.importPath);
        const plugin = mod[p.exportName] || mod.default;
        if (plugin) return { plugin, providerName: p.name };
      } catch (e) {
        console.warn(`Failed to load ${p.name}: ${e}`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const llmResult = await loadLLMPlugin();
  if (!llmResult) {
    console.error("No LLM API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.");
    process.exit(1);
  }
  console.log(`Using ${llmResult.providerName}\n`);

  const character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant.",
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmResult.plugin],
  });

  // The local runtime source uses batch adapter methods (getAgentsByIds,
  // upsertAgents, createRoomParticipants, etc.) that the published
  // plugin-sql@alpha.13 doesn't have. We use a Proxy to automatically
  // delegate batch calls to the singular equivalents.
  const origRegister = runtime.registerDatabaseAdapter.bind(runtime);
  runtime.registerDatabaseAdapter = function (adapter: any) {
    // Explicit shims for methods where the naming isn't a simple plural pattern
    const explicitShims: Record<string, (...args: any[]) => Promise<any>> = {
      // Agent batch methods
      getAgentsByIds: async (ids: string[]) => {
        const results = [];
        for (const id of ids) { const r = await adapter.getAgent(id); if (r) results.push(r); }
        return results;
      },
      upsertAgents: async (agents: any[]) => {
        for (const a of agents) {
          const existing = await adapter.getAgent(a.id);
          if (existing) await adapter.updateAgent(a.id, a);
          else await adapter.createAgent(a);
        }
      },
      createAgents: async (agents: any[]) => {
        for (const a of agents) await adapter.createAgent(a);
        return agents.map((a: any) => a.id);
      },
      updateAgents: async (updates: any[]) => {
        for (const u of updates) await adapter.updateAgent(u.agentId, u.agent);
        return true;
      },
      deleteAgents: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteAgent?.(id);
        return true;
      },

      // World batch methods
      getWorldsByIds: async (ids: string[]) => {
        const results = [];
        for (const id of ids) { const r = await adapter.getWorld?.(id); if (r) results.push(r); }
        return results;
      },
      upsertWorlds: async (worlds: any[]) => {
        for (const w of worlds) {
          const existing = await adapter.getWorld?.(w.id);
          if (existing) await adapter.updateWorld?.(w);
          else await adapter.createWorld?.(w);
        }
      },
      createWorlds: async (worlds: any[]) => {
        for (const w of worlds) await adapter.createWorld?.(w);
        return worlds.map((w: any) => w.id);
      },
      updateWorlds: async (worlds: any[]) => {
        for (const w of worlds) await adapter.updateWorld?.(w);
      },
      deleteWorlds: async (ids: string[]) => {
        for (const id of ids) await adapter.removeWorld?.(id);
      },

      // Room batch methods
      upsertRooms: async (rooms: any[]) => {
        for (const r of rooms) {
          try { await adapter.updateRoom?.(r); } catch { /* ignore */ }
        }
      },
      updateRooms: async (rooms: any[]) => {
        for (const r of rooms) await adapter.updateRoom?.(r);
      },
      deleteRooms: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteRoom?.(id);
      },
      deleteRoomsByWorldIds: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteRoomsByWorldId?.(id);
      },
      getRoomsByWorlds: async (ids: string[]) => {
        const all: any[] = [];
        for (const id of ids) {
          const rooms = await adapter.getRoomsByWorld?.(id);
          if (rooms) all.push(...rooms);
        }
        return all;
      },

      // Entity batch methods — the old adapter.createEntities returns boolean,
      // but the runtime expects UUID[]. Wrap it.
      createEntities: async (entities: any[]) => {
        const result = await adapter.createEntities(entities);
        if (result === true) return entities.map((e: any) => e.id);
        if (Array.isArray(result)) return result;
        return [];
      },
      upsertEntities: async (entities: any[]) => {
        for (const e of entities) {
          await adapter.ensureEntityExists?.(e) ?? await adapter.updateEntity?.(e.id, e);
        }
      },
      updateEntities: async (entities: any[]) => {
        for (const e of entities) await adapter.updateEntity?.(e.id, e);
      },
      deleteEntities: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteEntity?.(id);
      },
      getEntitiesForRooms: async (roomIds: string[], includeComponents?: boolean) => {
        const all: any[] = [];
        for (const id of roomIds) {
          const entities = await adapter.getEntitiesForRoom?.(id, includeComponents);
          if (entities) all.push(...entities);
        }
        return all;
      },

      // Participant batch methods
      createRoomParticipants: async (entityIds: string[], roomId: string) => {
        for (const eid of entityIds) await adapter.addParticipant?.(eid, roomId);
        return entityIds;
      },
      getParticipantsForRooms: async (roomIds: string[]) => {
        const all: any[] = [];
        for (const id of roomIds) {
          const p = await adapter.getParticipantsForRoom?.(id);
          all.push(p ?? []);
        }
        return all;
      },
      getParticipantsForEntities: async (entityIds: string[]) => {
        const all: any[] = [];
        for (const id of entityIds) {
          const p = await adapter.getParticipantsForEntity?.(id);
          if (p) all.push(...p);
        }
        return all;
      },
      areRoomParticipants: async (pairs: any[]) => {
        const results: boolean[] = [];
        for (const p of pairs) {
          const r = await adapter.isRoomParticipant?.(p.entityId, p.roomId);
          results.push(!!r);
        }
        return results;
      },
      updateParticipants: async () => true,
      deleteParticipants: async (entityIds: string[], roomId: string) => {
        for (const id of entityIds) await adapter.removeParticipant?.(id, roomId);
      },
      getParticipantUserStates: async (roomId: string, entityIds: string[]) => {
        const results: any[] = [];
        for (const id of entityIds) {
          const s = await adapter.getParticipantUserState?.(roomId, id);
          results.push(s);
        }
        return results;
      },
      updateParticipantUserStates: async (roomId: string, updates: any[]) => {
        for (const u of updates) await adapter.setParticipantUserState?.(roomId, u.entityId, u.state);
      },

      // Relationship batch methods
      getRelationshipsByIds: async (ids: string[]) => {
        const results: any[] = [];
        for (const id of ids) {
          const r = await adapter.getRelationship?.(id);
          if (r) results.push(r);
        }
        return results;
      },
      createRelationships: async (rels: any[]) => {
        for (const r of rels) await adapter.createRelationship?.(r);
        return true;
      },
      updateRelationships: async (rels: any[]) => {
        for (const r of rels) await adapter.updateRelationship?.(r);
      },
      deleteRelationships: async () => true,
      getRelationshipsByPairs: async (pairs: any[]) => {
        // Best-effort: fetch all relationships for first entity, filter
        const results: any[] = [];
        for (const p of pairs) {
          const rels = await adapter.getRelationships?.({ entityId: p.entityA });
          const match = rels?.find?.((r: any) =>
            (r.sourceEntityId === p.entityA && r.targetEntityId === p.entityB) ||
            (r.sourceEntityId === p.entityB && r.targetEntityId === p.entityA));
          results.push(match ?? null);
        }
        return results;
      },

      // Component batch methods
      getComponentsByIds: async (ids: string[]) => {
        const results: any[] = [];
        for (const id of ids) {
          const c = await adapter.getComponent?.(id);
          if (c) results.push(c);
        }
        return results;
      },
      getComponentsForEntities: async (entityIds: string[], worldId?: string) => {
        const results: any[] = [];
        for (const id of entityIds) {
          const comps = await adapter.getComponents?.(id, worldId);
          if (comps) results.push(...comps);
        }
        return results;
      },
      getComponentsByNaturalKeys: async (keys: any[]) => {
        // Approximate: try to get components and filter
        return [];
      },
      createComponents: async (comps: any[]) => {
        for (const c of comps) await adapter.createComponent?.(c);
      },
      updateComponents: async (comps: any[]) => {
        for (const c of comps) await adapter.updateComponent?.(c);
      },
      upsertComponents: async (comps: any[]) => {
        for (const c of comps) {
          try { await adapter.createComponent?.(c); } catch { await adapter.updateComponent?.(c); }
        }
      },
      patchComponents: async (patches: any[]) => {
        for (const p of patches) await adapter.updateComponent?.(p);
      },
      deleteComponents: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteComponent?.(id);
      },

      // Memory batch methods
      createMemories: async (memories: any[], tableName?: string) => {
        for (const m of memories) await adapter.createMemory?.(m, tableName);
      },
      updateMemories: async (memories: any[]) => {
        for (const m of memories) await adapter.updateMemory?.(m);
      },
      upsertMemories: async (memories: any[], tableName?: string) => {
        for (const m of memories) await adapter.createMemory?.(m, tableName, true);
      },
      deleteMemories: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteMemory?.(id);
      },
      deleteAllMemories: async (roomIds: string[], tableName?: string) => {
        for (const id of roomIds) await adapter.deleteAllMemories?.(id, tableName);
      },

      // Task batch methods
      createTasks: async (tasks: any[]) => {
        for (const t of tasks) await adapter.createTask?.(t);
      },
      getTasksByIds: async (ids: string[]) => {
        const results: any[] = [];
        for (const id of ids) {
          const t = await adapter.getTask?.(id);
          if (t) results.push(t);
        }
        return results;
      },
      updateTasks: async (tasks: any[]) => {
        for (const t of tasks) await adapter.updateTask?.(t);
      },
      deleteTasks: async (ids: string[]) => {
        for (const id of ids) await adapter.deleteTask?.(id);
      },

      // Log batch methods
      createLogs: async (logs: any[]) => {
        // plugin-sql may not have createLog, just swallow
        return [];
      },
      getLogsByIds: async (ids: string[]) => [],
      updateLogs: async () => true,
      deleteLogs: async () => true,

      // Cache batch methods
      setCaches: async (entries: any[]) => {
        for (const e of entries) await adapter.setCache?.(e);
      },
      deleteCaches: async (keys: any[]) => {
        for (const k of keys) await adapter.deleteCache?.(k);
      },

      // Pairing batch methods
      getPairingAllowlists: async (params: any) => {
        return await adapter.getPairingAllowlist?.(params) ?? [];
      },
      createPairingAllowlistEntries: async (entries: any[]) => {
        for (const e of entries) await adapter.createPairingAllowlistEntry?.(e);
      },
      updatePairingAllowlistEntries: async (entries: any[]) => {
        // no-op for old adapter
      },
      deletePairingAllowlistEntries: async (ids: any[]) => {
        for (const id of ids) await adapter.deletePairingAllowlistEntry?.(id);
      },
      createPairingRequests: async (reqs: any[]) => {
        for (const r of reqs) await adapter.createPairingRequest?.(r);
      },
      updatePairingRequests: async (reqs: any[]) => {
        for (const r of reqs) await adapter.updatePairingRequest?.(r);
      },
      deletePairingRequests: async (ids: any[]) => {
        for (const id of ids) await adapter.deletePairingRequest?.(id);
      },

      // Transaction
      transaction: adapter.transaction?.bind(adapter) ?? (async (fn: any) => fn(adapter.db)),
    };

    const proxied = new Proxy(adapter, {
      get(target: any, prop: string | symbol) {
        // Always prefer our shims — they fix return-type mismatches
        // between the published plugin-sql and the local runtime source.
        if (typeof prop === "string" && prop in explicitShims) {
          return explicitShims[prop];
        }
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    origRegister(proxied);
  };
  await runtime.initialize();

  const userId = uuidv4() as UUID;
  const roomId = stringToUuid("context-test-room");
  const worldId = stringToUuid("context-test-world");

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "Tester",
    source: "cli",
    channelId: "context-test",
    type: ChannelType.DM,
  });

  // Create a trajectory step ID so the TrajectoryLoggerService captures everything
  const trajectoryStepId = uuidv4();

  const message = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: "hello, how are you?",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
    metadata: { trajectoryStepId },
  });

  console.log("--- Sending: \"hello, how are you?\" ---\n");

  let response = "";
  await runtime.messageService?.handleMessage(
    runtime,
    message,
    async (content) => {
      if (content?.text) {
        response += content.text;
      }
      return [];
    },
  );

  // Retrieve trajectory logs
  type TrajectoryLogger = {
    getLlmCallLogs: () => readonly {
      stepId: string;
      model: string;
      systemPrompt: string;
      userPrompt: string;
      response: string;
      temperature: number;
      maxTokens: number;
      purpose: string;
      actionType: string;
      latencyMs: number;
      timestamp: number;
    }[];
    getProviderAccessLogs: () => readonly {
      stepId: string;
      providerName: string;
      purpose: string;
      data: Record<string, unknown>;
      query?: Record<string, unknown>;
      timestamp: number;
    }[];
  };

  const trajLogger = runtime.getService<TrajectoryLogger>("trajectory_logger");

  console.log("=".repeat(80));
  console.log("AGENT RESPONSE");
  console.log("=".repeat(80));
  console.log(response || "(empty)");
  console.log();

  if (trajLogger) {
    const llmCalls = trajLogger.getLlmCallLogs();
    const providerLogs = trajLogger.getProviderAccessLogs();

    console.log("=".repeat(80));
    console.log(`PROVIDER ACCESSES (${providerLogs.length} total)`);
    console.log("=".repeat(80));
    for (const log of providerLogs) {
      console.log(`\n  [${log.providerName}] purpose=${log.purpose}`);
      console.log(`    data keys: ${Object.keys(log.data).join(", ")}`);
      if (log.data.textLength) {
        console.log(`    text length: ${log.data.textLength} chars`);
      }
    }

    console.log();
    console.log("=".repeat(80));
    console.log(`LLM CALLS (${llmCalls.length} total)`);
    console.log("=".repeat(80));

    for (let i = 0; i < llmCalls.length; i++) {
      const call = llmCalls[i];
      console.log(`\n${"─".repeat(60)}`);
      console.log(`LLM Call #${i + 1}: model=${call.model} purpose=${call.purpose} action=${call.actionType}`);
      console.log(`latency=${call.latencyMs}ms temp=${call.temperature} maxTokens=${call.maxTokens}`);
      console.log(`${"─".repeat(60)}`);

      console.log("\n>>> SYSTEM PROMPT:");
      console.log(call.systemPrompt || "(none)");

      console.log("\n>>> USER PROMPT (input to model):");
      console.log(call.userPrompt);

      console.log("\n>>> MODEL RESPONSE:");
      console.log(call.response);
    }
  } else {
    console.log("(TrajectoryLoggerService not found — no detailed logs available)");
  }

  console.log("\n" + "=".repeat(80));
  console.log("Done.");
  await runtime.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
