import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

interface ReqOptions {
  headers?: Record<string, string>;
}

function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  opts?: ReqOptions,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
          ...(opts?.headers ?? {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

function saveEnv(...keys: string[]): { restore: () => void } {
  const prev = new Map<string, string | undefined>();
  for (const key of keys) prev.set(key, process.env[key]);
  return {
    restore: () => {
      for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

describe("Terminal run validation and limit guards", () => {
  const TEST_CLIENT_ID = "terminal-run-limits-e2e";
  let port: number;
  let close: () => Promise<void>;
  let envBackup: { restore: () => void };

  beforeAll(async () => {
    envBackup = saveEnv(
      "MILADY_TERMINAL_MAX_CONCURRENT",
      "MILADY_TERMINAL_MAX_DURATION_MS",
      "MILADY_TERMINAL_MAX_CONCURRENT",
      "MILADY_TERMINAL_MAX_DURATION_MS",
    );
    const result = await startApiServer({ port: 0 });
    port = result.port;
    close = result.close;
  });

  beforeEach(async () => {
    await req(port, "PUT", "/api/permissions/shell", { enabled: true });
    delete process.env.MILADY_TERMINAL_MAX_CONCURRENT;
    delete process.env.MILADY_TERMINAL_MAX_DURATION_MS;
    delete process.env.MILADY_TERMINAL_MAX_CONCURRENT;
    delete process.env.MILADY_TERMINAL_MAX_DURATION_MS;
  });

  afterAll(async () => {
    await close();
    envBackup.restore();
  });

  it("rejects commands longer than 4096 characters", async () => {
    const { status, data } = await req(port, "POST", "/api/terminal/run", {
      command: "x".repeat(4097),
      clientId: TEST_CLIENT_ID,
    });

    expect(status).toBe(400);
    expect(data).toHaveProperty(
      "error",
      "Command exceeds maximum length (4096 chars)",
    );
  });

  it("enforces max concurrent terminal runs", async () => {
    process.env.MILADY_TERMINAL_MAX_CONCURRENT = "1";

    const first = await req(port, "POST", "/api/terminal/run", {
      command: 'node -e "setTimeout(() => process.exit(0), 1200)"',
      clientId: TEST_CLIENT_ID,
    });
    expect(first.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const second = await req(port, "POST", "/api/terminal/run", {
      command: "echo second",
      clientId: TEST_CLIENT_ID,
    });
    expect(second.status).toBe(429);
    expect(second.data.error).toContain("Too many active terminal runs");

    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
});
