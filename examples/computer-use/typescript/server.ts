/**
 * ComputerUse Example (TypeScript)
 *
 * Starts an elizaOS agent and exposes it over HTTP (A2A-style).
 * The agent is granted ComputerUse actions via @elizaos/plugin-computeruse.
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
import inmemorydbPlugin from "@elizaos/plugin-inmemorydb";
import mcpPlugin from "@elizaos/plugin-mcp";
import computerusePlugin from "@elizaos/plugin-computeruse";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

const PORT = Number(process.env.PORT ?? 3333);

// Enable ComputerUse by default for this example.
process.env.COMPUTERUSE_ENABLED = process.env.COMPUTERUSE_ENABLED ?? "true";
process.env.COMPUTERUSE_MODE = process.env.COMPUTERUSE_MODE ?? "auto";
process.env.COMPUTERUSE_MCP_SERVER = process.env.COMPUTERUSE_MCP_SERVER ?? "computeruse";
const HAS_OPENAI =
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim().length > 0;

const CHARACTER = createCharacter({
  name: "OkComputer",
  bio: "An elizaOS agent with computer control abilities.",
  system: [
    "You can control the user's computer using ComputerUse actions.",
    "Use COMPUTERUSE_OPEN_APPLICATION / COMPUTERUSE_CLICK / COMPUTERUSE_TYPE as needed.",
    "Prefer deterministic selectors like role+name.",
    "If you are operating autonomously, continue making progress on the user's latest request.",
  ].join("\n"),
  settings: {
    // MCP server configuration (used when COMPUTERUSE_MODE=mcp or on non-Windows in auto mode).
    // For remote control: point this at a Windows machine running computeruse-mcp-agent in HTTP mode.
    // For local stdio spawn: keep it as stdio.
    mcp: {
      servers: {
        computeruse: {
          type: "stdio",
          command: "npx",
          args: ["-y", "computeruse-mcp-agent@latest"],
          timeoutInMillis: 60000,
        },
      },
    },
    // Autonomy is controlled via runtime.enableAutonomy
    AUTONOMY_MODE: process.env.AUTONOMY_MODE ?? "task",
  },
});

let runtime: AgentRuntime | null = null;
const sessions: Map<string, { roomId: UUID; userId: UUID }> = new Map();
const worldId = stringToUuid("computeruse-example-world");
const messageServerId = stringToUuid("computeruse-example-server");

type JsonObject = Record<string, ContentValue>;

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;

  const llmPlugin = HAS_OPENAI ? openaiPlugin : elizaClassicPlugin;

  runtime = new AgentRuntime({
    character: CHARACTER,
    plugins: [inmemorydbPlugin, llmPlugin, mcpPlugin, computerusePlugin],
    enableAutonomy: true,
    // We want a chat UI; always respond in DM.
    checkShouldRespond: false,
    logLevel: "info",
  });

  await runtime.initialize();
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
  opts?: { context?: JsonObject },
): Promise<string> {
  const rt = await initializeRuntime();
  const { roomId, userId } = getOrCreateSession(sessionId);

  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: `User-${sessionId}`,
    source: "computer-use-example",
    channelId: "http",
    messageServerId,
    type: ChannelType.DM,
  });

  // Make this chat session the default autonomy target room.
  rt.setSetting("AUTONOMY_TARGET_ROOM_ID", String(roomId));

  const content: { text: string; source: string; channelType: ChannelType } & JsonObject =
    {
      text: message,
      source: "computer-use-example",
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

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await initializeRuntime();
      res.json({ status: "ok" });
    } catch (e) {
      res.status(503).json({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  });

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

  app.get("/config", async (_req: Request, res: Response) => {
    res.json({
      hasOpenAi: HAS_OPENAI,
      computeruseMode: process.env.COMPUTERUSE_MODE ?? "auto",
    });
  });

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
    // Ensure task mode for this example.
    rt.setSetting("AUTONOMY_MODE", "task");
    // Make the loop responsive for demo purposes.
    svc.setLoopInterval(5000);
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
        const id = m.id ?? "";
        if (seen.has(id)) return false;
        seen.add(id);
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
    console.log(`ComputerUse example server running: http://localhost:${PORT}`);
    console.log("POST /chat { message }");
  });
}

