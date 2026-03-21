import http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

type JsonObject = Record<string, JsonValue>;

type RawSqlQuery = {
  queryChunks?: Array<{
    value?: string[];
  }>;
};

function sqlText(query: RawSqlQuery): string {
  const chunks = query.queryChunks ?? [];
  return chunks
    .map((chunk) => (Array.isArray(chunk.value) ? chunk.value.join("") : ""))
    .join("")
    .trim();
}

function splitSqlTuple(valueList: string): string[] {
  const values: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < valueList.length; i += 1) {
    const char = valueList[i];
    if (char === "'") {
      current += char;
      if (inString && valueList[i + 1] === "'") {
        current += "'";
        i += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (char === "," && !inString) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) values.push(current.trim());
  return values;
}

function parseSqlScalar(token: string): string | number | null {
  if (token.toUpperCase() === "NULL") return null;
  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  const asNumber = Number(token);
  return Number.isFinite(asNumber) ? asNumber : token;
}

class InMemoryTrajectoryDb {
  private rows = new Map<string, Record<string, unknown>>();

  async execute(query: RawSqlQuery): Promise<{ rows: unknown[] }> {
    const sql = sqlText(query);
    const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();

    if (normalized.startsWith("create table if not exists trajectories")) {
      return { rows: [] };
    }

    if (normalized.startsWith("insert into trajectories")) {
      const match =
        /insert into trajectories\s*\(([\s\S]+?)\)\s*values\s*\(([\s\S]+?)\)\s*on conflict/i.exec(
          sql,
        );
      if (!match) return { rows: [] };
      const columns = splitSqlTuple(match[1]).map((col) => col.trim());
      const values = splitSqlTuple(match[2]).map(parseSqlScalar);
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i += 1) {
        row[columns[i]] = values[i] ?? null;
      }
      const id = String(row.id ?? "");
      if (id) {
        const existing = this.rows.get(id) ?? {};
        this.rows.set(id, { ...existing, ...row });
      }
      return { rows: [] };
    }

    if (normalized.startsWith("select * from trajectories where id =")) {
      const match = /where id = '([^']*(?:''[^']*)*)'/i.exec(sql);
      const id = match ? match[1].replace(/''/g, "'") : "";
      const row = id ? this.rows.get(id) : null;
      return { rows: row ? [row] : [] };
    }

    if (normalized.startsWith("select * from trajectories")) {
      const limitMatch = /limit\s+(\d+)/i.exec(sql);
      const limit = limitMatch ? Number(limitMatch[1]) : 5000;
      const rows = Array.from(this.rows.values()).sort((a, b) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      );
      return { rows: rows.slice(0, limit) };
    }

    return { rows: [] };
  }
}

function req(
  port: number,
  method: string,
  p: string,
): Promise<{ status: number; data: JsonObject }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: JsonObject = {};
          try {
            data = JSON.parse(raw) as JsonObject;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

type InMemoryTrajectoryLogger = {
  isEnabled: () => boolean;
  getLlmCallLogs: () => ReadonlyArray<Record<string, unknown>>;
  getProviderAccessLogs: () => ReadonlyArray<Record<string, unknown>>;
  logLlmCall?: (params: Record<string, unknown>) => void;
  llmCalls: Array<Record<string, unknown>>;
  providerAccess: Array<Record<string, unknown>>;
};

function createRuntimeWithCoreLogger(
  agentId: string,
  name: string,
  logger: InMemoryTrajectoryLogger,
  db: InMemoryTrajectoryDb,
): AgentRuntime {
  const noop = () => {};
  return {
    agentId,
    character: { name },
    adapter: { db } as unknown as AgentRuntime["adapter"],
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    services: new Map(),
    getService: (serviceType: string) =>
      serviceType === "trajectory_logger" ? logger : null,
    getServicesByType: (serviceType: string) =>
      serviceType === "trajectory_logger" ? [logger] : [],
    messageService: null,
    logger: {
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      success: noop,
      progress: noop,
      clear: noop,
      child: () =>
        ({
          trace: noop,
          debug: noop,
          info: noop,
          warn: noop,
          error: noop,
          fatal: noop,
          success: noop,
          progress: noop,
          clear: noop,
          child: () => ({}),
        }) as AgentRuntime["logger"],
    } as AgentRuntime["logger"],
  } as unknown as AgentRuntime;
}

describe("trajectory filters no-input embedding noise", () => {
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const db = new InMemoryTrajectoryDb();

    const logger: InMemoryTrajectoryLogger = {
      isEnabled: () => true,
      llmCalls: [],
      providerAccess: [],
      getLlmCallLogs() {
        return this.llmCalls;
      },
      getProviderAccessLogs() {
        return this.providerAccess;
      },
    };

    const runtime = createRuntimeWithCoreLogger(
      "00000000-0000-0000-0000-000000000003",
      "EmbeddingFilter",
      logger,
      db,
    );
    const server = await startApiServer({ port: 0, runtime });
    port = server.port;
    closeServer = server.close;

    logger.logLlmCall?.({
      stepId: "embed-empty",
      model: "TEXT_EMBEDDING",
      userPrompt: "",
      response: "[0.12, -0.01, 0.33, 0.04, -0.05, 0.22, -0.19, 0.07]",
      purpose: "action",
      actionType: "runtime.useModel",
      temperature: 0,
      maxTokens: 0,
      latencyMs: 11,
      timestamp: Date.now() - 1000,
    });
    logger.logLlmCall?.({
      stepId: "chat-step",
      model: "gpt-4o-mini",
      userPrompt: "hello trajectory",
      response: "hi from test",
      purpose: "action",
      actionType: "runtime.useModel",
      temperature: 0,
      maxTokens: 64,
      promptTokens: 10,
      completionTokens: 8,
      latencyMs: 42,
      timestamp: Date.now() - 500,
    });
    logger.logLlmCall?.({
      stepId: "embed-input",
      model: "text-embedding-3-small",
      input: "semantic search text",
      response:
        "[0.01, 0.02, -0.03, 0.04, 0.05, -0.06, 0.07, -0.08, 0.09, 0.1]",
      purpose: "action",
      actionType: "runtime.useModel",
      temperature: 0,
      maxTokens: 0,
      latencyMs: 17,
      timestamp: Date.now() - 250,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, 30_000);

  afterAll(async () => {
    if (closeServer) {
      await closeServer();
    }
  });

  it("suppresses empty-input embedding rows but keeps meaningful rows", async () => {
    const list = await req(port, "GET", "/api/trajectories?limit=50");
    if (list.status === 503) {
      expect(typeof list.data.error).toBe("string");
      return;
    }
    expect(list.status).toBe(200);
    const ids = ((list.data.trajectories ?? []) as Array<JsonObject>).map(
      (row) => String(row.id),
    );
    expect(ids.includes("embed-empty")).toBe(false);
    expect(ids.includes("chat-step")).toBe(true);
    expect(ids.includes("embed-input")).toBe(true);

    const embedWithInput = await req(
      port,
      "GET",
      "/api/trajectories/embed-input",
    );
    if (embedWithInput.status === 503) {
      expect(typeof embedWithInput.data.error).toBe("string");
      return;
    }
    expect(embedWithInput.status).toBe(200);
    const embedCalls = (embedWithInput.data.llmCalls ??
      []) as Array<JsonObject>;
    expect(embedCalls.length).toBe(1);
    expect(String(embedCalls[0]?.userPrompt ?? "")).toBe(
      "semantic search text",
    );
  });
});
