/**
 * Browser Use Example (TypeScript)
 *
 * An autonomous ElizaOS agent that explores the web with curiosity,
 * focusing on understanding quantum physics and related concepts.
 *
 * The agent:
 * - Navigates to physics education websites
 * - Reads and extracts information about quantum mechanics
 * - Explores related concepts autonomously
 * - Synthesizes knowledge and forms understanding
 */

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type ContentValue,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { AutonomyService } from "@elizaos/core";
import { elizaClassicPlugin } from "@elizaos/plugin-eliza-classic";
import openaiPlugin from "@elizaos/plugin-openai";
import { plugin as inmemorydbPlugin } from "@elizaos/plugin-inmemorydb";
import browserPlugin from "@elizaos/plugin-browser";
import express, { type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";

const PORT = Number(process.env.PORT ?? 3333);

const HAS_OPENAI =
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim().length > 0;

// Load shared character configuration
function loadCharacterConfig(): Record<string, unknown> {
  const characterPath = path.join(__dirname, "..", "character.json");
  try {
    const content = fs.readFileSync(characterPath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.warn(`Could not load character.json from ${characterPath}, using defaults`);
    return { name: "QuantumExplorer", topics: [], system: "", bio: "" };
  }
}

const CHARACTER_CONFIG = loadCharacterConfig();
const QUANTUM_TOPICS = (CHARACTER_CONFIG.topics as string[]) || [];

const CHARACTER = createCharacter({
  name: (CHARACTER_CONFIG.name as string) || "QuantumExplorer",
  bio: (CHARACTER_CONFIG.bio as string) || "A curious AI researcher fascinated by quantum physics.",
  system: (CHARACTER_CONFIG.system as string) || "You are QuantumExplorer, a curious AI researcher.",
  settings: {
    AUTONOMY_MODE: process.env.AUTONOMY_MODE ?? "task",
  },
});

let runtime: AgentRuntime | null = null;
const sessions: Map<string, { roomId: UUID; userId: UUID }> = new Map();
const worldId = stringToUuid("browser-use-quantum-world");
const messageServerId = stringToUuid("browser-use-quantum-server");

type JsonObject = Record<string, ContentValue>;

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;

  const llmPlugin = HAS_OPENAI ? openaiPlugin : elizaClassicPlugin;

  runtime = new AgentRuntime({
    character: CHARACTER,
    plugins: [inmemorydbPlugin, llmPlugin, browserPlugin],
    enableAutonomy: true,
    checkShouldRespond: false,
    logLevel: "info",
  });

  await runtime.initialize();

  console.log("QuantumExplorer initialized!");
  console.log("Available actions:", runtime.actions.map((a) => a.name).join(", "));
  console.log("Browser plugin ready for autonomous exploration.");

  return runtime;
}

function getOrCreateSession(sessionId: string): { roomId: UUID; userId: UUID } {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      roomId: stringToUuid(`room-${sessionId}`),
      userId: stringToUuid(`user-${sessionId}`),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

async function handleChat(
  message: string,
  sessionId: string,
  opts?: { context?: JsonObject }
): Promise<string> {
  const rt = await initializeRuntime();
  const { roomId, userId } = getOrCreateSession(sessionId);

  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: `Researcher-${sessionId}`,
    source: "browser-use-quantum",
    channelId: "http",
    messageServerId,
    type: ChannelType.DM,
  });

  rt.setSetting("AUTONOMY_TARGET_ROOM_ID", String(roomId));

  const content: { text: string; source: string; channelType: ChannelType } & JsonObject = {
    text: message,
    source: "browser-use-quantum",
    channelType: ChannelType.DM,
  };
  if (opts?.context) content.context = opts.context;

  const messageMemory = createMessageMemory({
    id: stringToUuid(uuidv4()),
    entityId: userId,
    roomId,
    content,
  });

  let response = "";
  const messageService = rt.messageService;
  if (!messageService) throw new Error("Message service not initialized");

  await messageService.handleMessage(rt, messageMemory, async (responseContent) => {
    if (responseContent?.text) response += responseContent.text;
    return [];
  });

  return response || "No response generated.";
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, "public")));

  // Health check
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await initializeRuntime();
      res.json({ status: "ok", agent: "QuantumExplorer" });
    } catch (e) {
      res.status(503).json({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Chat endpoint
  interface ChatRequestBody {
    message: string;
    sessionId?: string;
    context?: JsonObject;
  }

  app.post("/chat", async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, sessionId: clientSessionId, context } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message must be a string" });
      return;
    }

    const sessionId = clientSessionId ?? uuidv4();
    const response = await handleChat(message, sessionId, { context });
    res.json({ response, sessionId });
  });

  // Quick exploration starters
  app.post("/explore/quantum", async (req: Request, res: Response) => {
    const sessionId = uuidv4();
    const topic = QUANTUM_TOPICS[Math.floor(Math.random() * QUANTUM_TOPICS.length)] || "quantum physics";
    const exploration = CHARACTER_CONFIG.exploration as Record<string, string> | undefined;
    const arxivBase = exploration?.arxiv_base_url || "https://arxiv.org/search/?searchtype=all&query=";
    const arxivUrl = `${arxivBase}${topic.replace(/ /g, "+")}`;
    const promptTemplate = exploration?.initial_prompt_template ||
      "Research mission: Find NEW scientific discoveries about \"{topic}\" in quantum physics.\n\nNavigate to: {arxiv_url}";
    const prompt = promptTemplate.replace("{topic}", topic).replace("{arxiv_url}", arxivUrl);

    const response = await handleChat(prompt, sessionId);
    res.json({ response, sessionId, topic });
  });

  // Configuration info
  app.get("/config", async (_req: Request, res: Response) => {
    res.json({
      hasOpenAi: HAS_OPENAI,
      agentName: "QuantumExplorer",
      topics: QUANTUM_TOPICS,
    });
  });

  // Autonomy controls
  app.get("/autonomy/status", async (_req: Request, res: Response) => {
    const rt = await initializeRuntime();
    const svc = rt.getService<AutonomyService>("AUTONOMY");
    if (!svc) {
      res.status(503).json({ success: false, error: "Autonomy service not available" });
      return;
    }
    const status = svc.getStatus();
    res.json({
      success: true,
      data: {
        status,
        mode: rt.getSetting("AUTONOMY_MODE"),
        targetRoomId: rt.getSetting("AUTONOMY_TARGET_ROOM_ID"),
      },
    });
  });

  app.post("/autonomy/enable", async (_req: Request, res: Response) => {
    const rt = await initializeRuntime();
    const svc = rt.getService<AutonomyService>("AUTONOMY");
    if (!svc) {
      res.status(503).json({ success: false, error: "Autonomy service not available" });
      return;
    }
    rt.setSetting("AUTONOMY_MODE", "continuous");
    svc.setLoopInterval(10000); // Check every 10 seconds
    await svc.enableAutonomy();
    res.json({ success: true, data: { status: svc.getStatus() } });
  });

  app.post("/autonomy/disable", async (_req: Request, res: Response) => {
    const rt = await initializeRuntime();
    const svc = rt.getService<AutonomyService>("AUTONOMY");
    if (!svc) {
      res.status(503).json({ success: false, error: "Autonomy service not available" });
      return;
    }
    await svc.disableAutonomy();
    res.json({ success: true, data: { status: svc.getStatus() } });
  });

  app.get("/autonomy/logs", async (_req: Request, res: Response) => {
    const rt = await initializeRuntime();
    const svc = rt.getService<AutonomyService>("AUTONOMY");
    if (!svc) {
      res.status(503).json({ success: false, error: "Autonomy service not available" });
      return;
    }
    const autonomyRoomId = svc.getAutonomousRoomId();
    const [memoriesTable, messagesTable] = await Promise.all([
      rt.getMemories({
        roomId: autonomyRoomId,
        count: 50,
        tableName: "memories",
      }),
      rt.getMemories({
        roomId: autonomyRoomId,
        count: 50,
        tableName: "messages",
      }),
    ]);

    const combined = [...memoriesTable, ...messagesTable];
    const seen = new Set<string>();
    const items = combined
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .map((m) => ({
        id: m.id,
        createdAt: m.createdAt || 0,
        text: typeof m.content.text === "string" ? m.content.text : "",
        source: m.content.source || "",
      }));
    res.json({ success: true, data: { autonomyRoomId, items } });
  });

  return app;
}

if (import.meta.main) {
  const app = createApp();
  await initializeRuntime();
  app.listen(PORT, () => {
    console.log(`\n🔬 QuantumExplorer running at http://localhost:${PORT}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Endpoints:");
    console.log("  POST /chat              - Chat with the agent");
    console.log("  POST /explore/quantum   - Start autonomous quantum exploration");
    console.log("  POST /autonomy/enable   - Enable continuous autonomous mode");
    console.log("  POST /autonomy/disable  - Disable autonomous mode");
    console.log("  GET  /autonomy/status   - Check autonomy status");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  });
}
