/**
 * Context Test Script
 *
 * Sends "hello, how are you?" to an agent and logs the full model
 * inputs (system prompt, user prompt) and outputs (response).
 *
 * Uses monkey-patching on runtime.useModel to capture all LLM calls,
 * avoiding adapter version mismatch issues with the trajectory logger.
 *
 * Usage:
 *   set -a && source ../examples/code/.env && set +a
 *   OPENAI_API_KEY="" bun run scripts/context-test.ts
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
// LLM provider detection
// ---------------------------------------------------------------------------

const LLM_PROVIDERS = [
  { name: "Anthropic", envKey: "ANTHROPIC_API_KEY", importPath: "@elizaos/plugin-anthropic", exportName: "anthropicPlugin" },
  { name: "OpenAI", envKey: "OPENAI_API_KEY", importPath: "@elizaos/plugin-openai", exportName: "openaiPlugin" },
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
// Adapter compatibility shim
// ---------------------------------------------------------------------------

/**
 * The local runtime source has been refactored to use batch adapter methods
 * (getAgentsByIds, upsertAgents, createEntities returning UUID[], etc.) that
 * the published plugin-sql@alpha.13 doesn't have. This Proxy intercepts
 * missing/incompatible methods and delegates to the singular equivalents.
 */
function shimAdapter(adapter: any): any {
  const shims: Record<string, (...args: any[]) => any> = {
    // Agents
    getAgentsByIds: async (ids: string[]) => {
      const r = []; for (const id of ids) { const a = await adapter.getAgent(id); if (a) r.push(a); } return r;
    },
    upsertAgents: async (agents: any[]) => {
      for (const a of agents) {
        const existing = await adapter.getAgent(a.id);
        if (existing) await adapter.updateAgent(a.id, a); else await adapter.createAgent(a);
      }
    },
    createAgents: async (agents: any[]) => { for (const a of agents) await adapter.createAgent(a); return agents.map((a: any) => a.id); },
    updateAgents: async (updates: any[]) => { for (const u of updates) await adapter.updateAgent(u.agentId, u.agent); return true; },
    deleteAgents: async (ids: string[]) => { for (const id of ids) await adapter.deleteAgent?.(id); return true; },

    // Entities — old createEntities returns boolean, new expects UUID[]
    createEntities: async (entities: any[]) => {
      const result = await adapter.createEntities(entities);
      return result === true ? entities.map((e: any) => e.id) : (Array.isArray(result) ? result : []);
    },
    upsertEntities: async (entities: any[]) => { for (const e of entities) await (adapter.ensureEntityExists?.(e) ?? adapter.updateEntity?.(e.id, e)); },
    updateEntities: async (entities: any[]) => { for (const e of entities) await adapter.updateEntity?.(e.id, e); },
    deleteEntities: async (ids: string[]) => { for (const id of ids) await adapter.deleteEntity?.(id); },
    getEntitiesForRooms: async (roomIds: string[], inc?: boolean) => {
      const r: any[] = []; for (const id of roomIds) { const e = await adapter.getEntitiesForRoom?.(id, inc); if (e) r.push(...e); } return r;
    },

    // Worlds
    getWorldsByIds: async (ids: string[]) => { const r = []; for (const id of ids) { const w = await adapter.getWorld?.(id); if (w) r.push(w); } return r; },
    upsertWorlds: async (worlds: any[]) => { for (const w of worlds) { const ex = await adapter.getWorld?.(w.id); if (ex) await adapter.updateWorld?.(w); else await adapter.createWorld?.(w); } },
    createWorlds: async (worlds: any[]) => { for (const w of worlds) await adapter.createWorld?.(w); return worlds.map((w: any) => w.id); },
    updateWorlds: async (worlds: any[]) => { for (const w of worlds) await adapter.updateWorld?.(w); },
    deleteWorlds: async (ids: string[]) => { for (const id of ids) await adapter.removeWorld?.(id); },

    // Rooms
    upsertRooms: async (rooms: any[]) => {
      // Try to get existing rooms and create/update accordingly
      for (const r of rooms) {
        const existing = await adapter.getRoomsByIds?.([r.id]);
        if (existing?.length) {
          await adapter.updateRoom?.(r);
        } else {
          await adapter.createRooms?.([r]);
        }
      }
    },
    updateRooms: async (rooms: any[]) => { for (const r of rooms) await adapter.updateRoom?.(r); },
    deleteRooms: async (ids: string[]) => { for (const id of ids) await adapter.deleteRoom?.(id); },
    deleteRoomsByWorldIds: async (ids: string[]) => { for (const id of ids) await adapter.deleteRoomsByWorldId?.(id); },
    getRoomsByWorlds: async (ids: string[]) => { const r: any[] = []; for (const id of ids) { const rooms = await adapter.getRoomsByWorld?.(id); if (rooms) r.push(...rooms); } return r; },

    // Participants
    createRoomParticipants: async (entityIds: string[], roomId: string) => { for (const eid of entityIds) await adapter.addParticipant?.(eid, roomId); return entityIds; },
    getParticipantsForRooms: async (roomIds: string[]) => { const r = []; for (const id of roomIds) { r.push(await adapter.getParticipantsForRoom?.(id) ?? []); } return r; },
    getParticipantsForEntities: async (entityIds: string[]) => { const r: any[] = []; for (const id of entityIds) { const p = await adapter.getParticipantsForEntity?.(id); if (p) r.push(...p); } return r; },
    areRoomParticipants: async (pairs: any[]) => { const r: boolean[] = []; for (const p of pairs) { r.push(!!(await adapter.isRoomParticipant?.(p.entityId, p.roomId))); } return r; },
    updateParticipants: async () => true,
    deleteParticipants: async (eids: string[], rid: string) => { for (const id of eids) await adapter.removeParticipant?.(id, rid); },
    getParticipantUserStates: async (pairs: any[]) => { const r = []; for (const p of pairs) r.push(await adapter.getParticipantUserState?.(p.roomId, p.entityId) ?? null); return r; },
    updateParticipantUserStates: async (updates: any[]) => { for (const u of updates) await adapter.setParticipantUserState?.(u.roomId, u.entityId, u.state); },

    // Relationships
    getRelationshipsByIds: async (ids: string[]) => { const r = []; for (const id of ids) { const rel = await adapter.getRelationship?.(id); if (rel) r.push(rel); } return r; },
    createRelationships: async (rels: any[]) => { for (const r of rels) await adapter.createRelationship?.(r); return true; },
    updateRelationships: async (rels: any[]) => { for (const r of rels) await adapter.updateRelationship?.(r); },
    deleteRelationships: async () => true,
    getRelationshipsByPairs: async (pairs: any[]) => { return pairs.map(() => null); },

    // Components
    getComponentsByIds: async (ids: string[]) => { const r = []; for (const id of ids) { const c = await adapter.getComponent?.(id); if (c) r.push(c); } return r; },
    getComponentsForEntities: async (eids: string[], wid?: string) => { const r: any[] = []; for (const id of eids) { const c = await adapter.getComponents?.(id, wid); if (c) r.push(...c); } return r; },
    getComponentsByNaturalKeys: async () => [],
    createComponents: async (cs: any[]) => { for (const c of cs) await adapter.createComponent?.(c); },
    updateComponents: async (cs: any[]) => { for (const c of cs) await adapter.updateComponent?.(c); },
    upsertComponents: async (cs: any[]) => { for (const c of cs) { try { await adapter.createComponent?.(c); } catch { await adapter.updateComponent?.(c); } } },
    patchComponents: async (ps: any[]) => { for (const p of ps) await adapter.updateComponent?.(p); },
    deleteComponents: async (ids: string[]) => { for (const id of ids) await adapter.deleteComponent?.(id); },

    // Memory — runtime passes [{memory, tableName, unique}] envelope objects
    createMemories: async (items: any[]) => {
      const ids = [];
      for (const item of items) {
        const mem = item.memory ?? item;
        const tn = item.tableName ?? "messages";
        await adapter.createMemory?.(mem, tn, item.unique);
        ids.push(mem.id);
      }
      return ids;
    },
    updateMemories: async (ms: any[]) => { for (const m of ms) await adapter.updateMemory?.(m); },
    upsertMemories: async (items: any[]) => {
      for (const item of items) {
        const mem = item.memory ?? item;
        const tn = item.tableName ?? "messages";
        await adapter.createMemory?.(mem, tn, true);
      }
    },
    deleteMemories: async (ids: string[]) => { for (const id of ids) await adapter.deleteMemory?.(id); },
    deleteAllMemories: async (rids: string[], tn?: string) => { for (const id of rids) await adapter.deleteAllMemories?.(id, tn); },

    // Tasks
    createTasks: async (ts: any[]) => {
      const ids: string[] = [];
      for (const t of ts) {
        const id = await adapter.createTask?.(t);
        ids.push(id ?? t.id ?? (await import("uuid")).v4());
      }
      return ids;
    },
    getTasksByIds: async (ids: string[]) => { const r = []; for (const id of ids) { const t = await adapter.getTask?.(id); if (t) r.push(t); } return r; },
    updateTasks: async (ts: any[]) => {
      for (const u of ts) {
        const id = u.id;
        const task = u.task ?? {};
        if (id != null) await adapter.updateTask?.(id, task);
      }
    },
    deleteTasks: async (ids: string[]) => { for (const id of ids) await adapter.deleteTask?.(id); },

    // Logs — swallow since old adapter may not have these
    createLogs: async () => [],
    getLogsByIds: async () => [],
    updateLogs: async () => true,
    deleteLogs: async () => true,

    // Cache
    setCaches: async (es: any[]) => { for (const e of es) await adapter.setCache?.(e); },
    deleteCaches: async (ks: any[]) => { for (const k of ks) await adapter.deleteCache?.(k); },

    // Pairing
    getPairingAllowlists: async (p: any) => await adapter.getPairingAllowlist?.(p) ?? [],
    createPairingAllowlistEntries: async (es: any[]) => { for (const e of es) await adapter.createPairingAllowlistEntry?.(e); },
    updatePairingAllowlistEntries: async () => {},
    deletePairingAllowlistEntries: async (ids: any[]) => { for (const id of ids) await adapter.deletePairingAllowlistEntry?.(id); },
    createPairingRequests: async (rs: any[]) => { for (const r of rs) await adapter.createPairingRequest?.(r); },
    updatePairingRequests: async (rs: any[]) => { for (const r of rs) await adapter.updatePairingRequest?.(r); },
    deletePairingRequests: async (ids: any[]) => { for (const id of ids) await adapter.deletePairingRequest?.(id); },
  };

  return new Proxy(adapter, {
    get(target: any, prop: string | symbol) {
      if (typeof prop === "string" && prop in shims) return shims[prop];
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

// ---------------------------------------------------------------------------
// LLM call capture (monkey-patch useModel)
// ---------------------------------------------------------------------------

type CapturedCall = {
  modelKey: string;
  prompt: string;
  response: string;
  elapsed: number;
};

const capturedCalls: CapturedCall[] = [];

function patchUseModel(runtime: any) {
  const origUseModel = runtime.useModel.bind(runtime);
  runtime.useModel = async function (modelKey: any, params: any) {
    const start = Date.now();
    const result = await origUseModel(modelKey, params);
    const elapsed = Date.now() - start;

    // Extract prompt from params
    let prompt = "";
    if (typeof params === "object" && params !== null) {
      if (typeof params.prompt === "string") prompt = params.prompt;
      else if (typeof params.context === "string") prompt = params.context;
      else if (params.messages) prompt = JSON.stringify(params.messages);
      else prompt = JSON.stringify(params);
    }

    capturedCalls.push({
      modelKey: String(modelKey),
      prompt,
      response: typeof result === "string" ? result : JSON.stringify(result),
      elapsed,
    });

    return result;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const llmResult = await loadLLMPlugin();
  if (!llmResult) {
    console.error("No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.");
    process.exit(1);
  }
  console.log(`Using ${llmResult.providerName}\n`);

  // Pass API keys through character secrets so runtime.getSetting() finds them
  const secrets: Record<string, string> = {};
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
    if (process.env[key]) secrets[key] = process.env[key]!;
  }

  const character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant.",
    secrets,
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmResult.plugin],
  });

  // Shim the adapter for batch method compatibility
  const origRegister = runtime.registerDatabaseAdapter.bind(runtime);
  runtime.registerDatabaseAdapter = function (adapter: any) {
    origRegister(shimAdapter(adapter));
  };

  // Patch useModel to capture all LLM calls
  patchUseModel(runtime);

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

  const message = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: "hello, how are you?",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  console.log('--- Sending: "hello, how are you?" ---\n');

  // Clear any init-time calls
  capturedCalls.length = 0;

  let response = "";
  await runtime.messageService?.handleMessage(
    runtime,
    message,
    async (content: any) => {
      if (content?.text) {
        response += content.text;
      }
      return [];
    },
  );

  console.log("=".repeat(80));
  console.log("AGENT RESPONSE");
  console.log("=".repeat(80));
  console.log(response || "(empty)");
  console.log();

  console.log("=".repeat(80));
  console.log(`LLM CALLS CAPTURED (${capturedCalls.length} total)`);
  console.log("=".repeat(80));

  for (let i = 0; i < capturedCalls.length; i++) {
    const call = capturedCalls[i];
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Call #${i + 1}: model=${call.modelKey} elapsed=${call.elapsed}ms`);
    console.log(`${"─".repeat(60)}`);

    console.log("\n>>> PROMPT (input to model):");
    console.log(call.prompt);

    console.log("\n>>> RESPONSE:");
    console.log(call.response);
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
