import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import {
  ChannelType,
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type MessageProcessingResult,
  type Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { RobloxService } from "@elizaos/plugin-roblox";

const ROBLOX_SERVICE_NAME = "roblox";

export type RobloxChatRequestBody = {
  playerId: number;
  playerName: string;
  text: string;
  placeId?: string;
  jobId?: string;
};

export type RobloxChatResponseBody = {
  reply: string;
  agentName: string;
};

export type RequestWithRawBody = Request & { rawBody?: string };
export type HeaderReader = { header: (name: string) => string | undefined; rawBody?: string };

export type RuntimeLike = {
  agentId: UUID;
  character: { name: string };
  ensureConnection: (args: {
    entityId: UUID;
    roomId: UUID;
    worldId: UUID;
    userName: string;
    source: string;
    channelId: string;
    type: ChannelType;
  }) => Promise<void>;
  messageService:
    | {
    handleMessage: (
      runtime: IAgentRuntime,
      message: Memory,
      callback?: (content: Content) => Promise<Memory[]>
    ) => Promise<MessageProcessingResult>;
  }
    | null;
  getService: <T extends Service>(serviceName: string) => T | null;
};

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifySharedSecret(req: HeaderReader, sharedSecret: string): boolean {
  if (!sharedSecret) return true;

  const headerSecret = req.header("x-eliza-secret") ?? "";
  if (headerSecret && timingSafeEqual(headerSecret, sharedSecret)) return true;

  // Optional HMAC mode:
  // x-eliza-signature: sha256=<hex(hmac_sha256(secret, rawBody))>
  const sig = req.header("x-eliza-signature") ?? "";
  if (!sig.startsWith("sha256=")) return false;
  const rawBody = req.rawBody ?? "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", sharedSecret).update(rawBody).digest("hex");
  return timingSafeEqual(sig, expected);
}

export function assertValidChatBody(body: RobloxChatRequestBody): void {
  if (!Number.isFinite(body.playerId)) throw new Error("playerId must be a number");
  if (!body.playerName || typeof body.playerName !== "string")
    throw new Error("playerName must be a string");
  if (!body.text || typeof body.text !== "string") throw new Error("text must be a string");
}

export function createRobloxBridgeApp(runtime: RuntimeLike, sharedSecret: string): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString("utf8");
      },
    })
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  const debugEnabled = process.env.DEBUG_ROBLOX_BRIDGE?.toLowerCase() === "true";
  if (debugEnabled) {
    app.get("/debug-env", (_req: Request, res: Response) => {
      res.json({
        DEBUG_ROBLOX_BRIDGE: process.env.DEBUG_ROBLOX_BRIDGE ?? null,
        ROBLOX_ECHO_TO_GAME: process.env.ROBLOX_ECHO_TO_GAME ?? null,
      });
    });
  }

  app.post(
    "/roblox/chat",
    async (req: Request<object, object, RobloxChatRequestBody>, res: Response) => {
      try {
        const rawReq = req as RequestWithRawBody;
        if (!verifySharedSecret(rawReq, sharedSecret)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        const body = req.body;
        assertValidChatBody(body);

        const userId = stringToUuid(`roblox:user:${body.playerId}`);
        const roomId = stringToUuid(`roblox:job:${body.jobId ?? "unknown"}`);
        const worldId = stringToUuid(`roblox:universe:${process.env.ROBLOX_UNIVERSE_ID ?? "unknown"}`);

        await runtime.ensureConnection({
          entityId: userId,
          roomId,
          worldId,
          userName: body.playerName,
          source: "roblox",
          channelId: "roblox_chat",
          type: ChannelType.DM,
        });

        const message = createMessageMemory({
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: body.text,
            source: "roblox_chat",
            channelType: ChannelType.DM,
          },
        });

        if (!runtime.messageService) {
          res.status(500).json({
            error:
              "Runtime message service not initialized. Ensure runtime.initialize() was called.",
          });
          return;
        }

        let reply = "";
        const result = await runtime.messageService.handleMessage(
          runtime as IAgentRuntime,
          message,
          async (content) => {
            if (content?.text) reply += content.text;
            return [];
          }
        );

        if (!reply.trim() && result.responseContent?.text) {
          reply = result.responseContent.text;
        }

        // Optional: echo the agent reply back into Roblox via Open Cloud publish
        // (Roblox servers subscribe and display it).
        if (process.env.ROBLOX_ECHO_TO_GAME?.toLowerCase() === "true") {
          const svc = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
          if (svc) {
            await svc.sendMessage(runtime.agentId, reply.trim() || "(no response)");
          }
        }

        const response: RobloxChatResponseBody = {
          reply: reply.trim() || "(no response)",
          agentName: runtime.character.name,
        };
        if (debugEnabled) {
          res.json({
            ...response,
            debug: {
              didRespond: result.didRespond,
              mode: result.mode ?? "none",
              hasResponseContent: result.responseContent !== null,
              responseContentText:
                typeof result.responseContent?.text === "string"
                  ? result.responseContent.text
                  : null,
              actions: Array.isArray(result.responseContent?.actions)
                ? result.responseContent.actions
                : null,
            },
          });
        } else {
          res.json(response);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        res.status(400).json({ error: msg });
      }
    }
  );

  return app;
}

