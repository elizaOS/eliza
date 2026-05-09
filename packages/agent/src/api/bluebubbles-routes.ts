import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";

const BLUEBUBBLES_SERVICE_NAME = "bluebubbles";
const DEFAULT_WEBHOOK_PATH = "/webhooks/bluebubbles";
const MAX_BODY_BYTES = 1_048_576;

type BlueBubblesWebhookPayload = {
  type: string;
  data: Record<string, unknown>;
};

type BlueBubblesChat = Record<string, unknown>;
type BlueBubblesMessage = Record<string, unknown>;

interface BlueBubblesClientLike {
  listChats(limit?: number, offset?: number): Promise<BlueBubblesChat[]>;
  getMessages(
    chatGuid: string,
    limit?: number,
    offset?: number,
  ): Promise<BlueBubblesMessage[]>;
}

interface BlueBubblesServiceLike {
  isConnected(): boolean;
  getWebhookPath(): string;
  getClient(): BlueBubblesClientLike | null;
  handleWebhook(payload: BlueBubblesWebhookPayload): Promise<void>;
}

export interface BlueBubblesRouteState {
  runtime?: {
    getService(type: string): unknown;
  };
}

function resolveService(
  state: BlueBubblesRouteState,
): BlueBubblesServiceLike | null {
  if (!state.runtime) {
    return null;
  }
  const raw = state.runtime.getService(BLUEBUBBLES_SERVICE_NAME);
  return (raw as BlueBubblesServiceLike | null | undefined) ?? null;
}

export function resolveBlueBubblesWebhookPath(
  state: BlueBubblesRouteState,
): string {
  const service = resolveService(state);
  const configuredPath = service?.getWebhookPath();
  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    return configuredPath.trim();
  }
  return DEFAULT_WEBHOOK_PATH;
}

export async function handleBlueBubblesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: BlueBubblesRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  const webhookPath = resolveBlueBubblesWebhookPath(state);
  const isWebhookPath = pathname === webhookPath;
  const isApiPath = pathname.startsWith("/api/bluebubbles");

  if (!isWebhookPath && !isApiPath) {
    return false;
  }

  if (method === "GET" && pathname === "/api/bluebubbles/status") {
    const service = resolveService(state);
    if (!service) {
      helpers.json(res, {
        available: false,
        connected: false,
        webhookPath,
        reason: "bluebubbles service not registered",
      });
      return true;
    }

    helpers.json(res, {
      available: true,
      connected: service.isConnected(),
      webhookPath,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/bluebubbles/chats") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "bluebubbles service not registered", 503);
      return true;
    }

    const client = service.getClient();
    if (!client) {
      helpers.error(res, "bluebubbles client not available", 503);
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const limit = Math.min(
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
      ),
      500,
    );
    const offset = Math.max(
      0,
      Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    );

    try {
      const chats = await client.listChats(limit, offset);
      helpers.json(res, { chats, count: chats.length, limit, offset });
    } catch (error) {
      helpers.error(
        res,
        `failed to read bluebubbles chats: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/bluebubbles/messages") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "bluebubbles service not registered", 503);
      return true;
    }

    const client = service.getClient();
    if (!client) {
      helpers.error(res, "bluebubbles client not available", 503);
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const chatGuid = (url.searchParams.get("chatGuid") ?? "").trim();
    if (!chatGuid) {
      helpers.error(res, "chatGuid query parameter is required", 400);
      return true;
    }

    const limit = Math.min(
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
      ),
      500,
    );
    const offset = Math.max(
      0,
      Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    );

    try {
      const messages = await client.getMessages(chatGuid, limit, offset);
      helpers.json(res, {
        chatGuid,
        messages,
        count: messages.length,
        limit,
        offset,
      });
    } catch (error) {
      helpers.error(
        res,
        `failed to read bluebubbles messages: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  if (method === "POST" && isWebhookPath) {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "bluebubbles service not registered", 503);
      return true;
    }

    const payload = await helpers.readJsonBody<BlueBubblesWebhookPayload>(
      req,
      res,
      { maxBytes: MAX_BODY_BYTES },
    );
    if (!payload) {
      return true;
    }

    if (
      typeof payload.type !== "string" ||
      !payload.type.trim() ||
      typeof payload.data !== "object" ||
      payload.data === null ||
      Array.isArray(payload.data)
    ) {
      helpers.error(res, "invalid BlueBubbles webhook payload", 400);
      return true;
    }

    try {
      await service.handleWebhook(payload);
      helpers.json(res, { ok: true });
    } catch (error) {
      helpers.error(
        res,
        `failed to handle bluebubbles webhook: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return true;
  }

  return false;
}
