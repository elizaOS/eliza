import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_CONFIG, type AppConfig } from "./types";
import { getGreetingText, getHistory, resetConversation, sendMessage } from "./runtimeManager";

const PORT = Number(process.env.PORT ?? "8787");

type ApiError = { error: string };

function sendJson(res: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", (err) => reject(err));
  });
}

function parseConfig(input: AppConfig | undefined): AppConfig {
  // For this example we accept a full config object from the client.
  // If missing/invalid, fall back to defaults.
  if (!input) return DEFAULT_CONFIG;
  return input;
}

export function createApiServer() {
  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (method === "GET" && url === "/health") {
        sendJson(res, 200, { ok: true, name: "eliza-capacitor-backend" });
        return;
      }

      if (method === "POST" && url === "/greeting") {
        const bodyText = await readBody(req);
        const parsed = (bodyText ? JSON.parse(bodyText) : {}) as { config?: AppConfig };
        const config = parseConfig(parsed.config);
        sendJson(res, 200, { greeting: getGreetingText(config) });
        return;
      }

      if (method === "POST" && url === "/history") {
        const bodyText = await readBody(req);
        const parsed = (bodyText ? JSON.parse(bodyText) : {}) as { config?: AppConfig };
        const config = parseConfig(parsed.config);
        const history = await getHistory(config);
        sendJson(res, 200, { history });
        return;
      }

      if (method === "POST" && url === "/reset") {
        const bodyText = await readBody(req);
        const parsed = (bodyText ? JSON.parse(bodyText) : {}) as { config?: AppConfig };
        const config = parseConfig(parsed.config);
        await resetConversation(config);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url === "/chat") {
        const bodyText = await readBody(req);
        const parsed = (bodyText ? JSON.parse(bodyText) : {}) as {
          config?: AppConfig;
          text?: string;
        };
        const config = parseConfig(parsed.config);
        const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        if (!text) {
          sendJson(res, 400, { error: "Missing 'text' in request body" } satisfies ApiError);
          return;
        }

        const result = await sendMessage(config, text);
        sendJson(res, 200, result);
        return;
      }

      sendText(res, 404, "Not found");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: msg } satisfies ApiError);
    }
  });
}

export function startServer(port = PORT) {
  const server = createApiServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[capacitor-backend] listening on http://localhost:${port}`);
  });
  return server;
}

if (import.meta.main) {
  startServer();
}

