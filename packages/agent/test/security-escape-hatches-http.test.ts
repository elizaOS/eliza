/** Real pre-auth HTML and persisted MCP writes through the maintained HTTP server. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const originalCwd = process.cwd();
const apiToken = randomUUID();
const terminalToken = randomUUID();
let directory: string;
let configPath: string;
let server: Awaited<ReturnType<typeof startApiServer>> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "security-http-boundary-"));
  configPath = path.join(directory, "config.json");
  const ui = path.join(directory, "packages/app/web-dist");
  await mkdir(ui, { recursive: true });
  await writeFile(
    path.join(ui, "index.html"),
    "<!doctype html><html><head><title>Boundary fixture</title></head><body>Boundary fixture</body></html>",
  );
  await writeFile(
    configPath,
    JSON.stringify({ meta: { firstRunComplete: true } }),
  );
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    NODE_ENV: "production",
    SECRET_SALT: randomUUID(),
    ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: "1",
    ELIZA_FORCE_INJECT_TOKEN: "true",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  process.chdir(directory);
});

afterAll(async () => {
  await server?.close();
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function start(token: string | undefined, terminal: string | undefined) {
  await server?.close();
  server = undefined;
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", token ? "1" : undefined);
  vi.stubEnv("ELIZA_TERMINAL_RUN_TOKEN", terminal);
  server = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
    initialAgentState: "not_started",
  });
  return `http://127.0.0.1:${server.port}`;
}

const stdio = { type: "stdio", command: "node", args: ["--version"] };
function send(
  base: string,
  route: string,
  body: unknown,
  method = "POST",
  headers: Record<string, string> = {},
) {
  return fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function stored() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

it("serves pre-auth dashboard HTML without introducing the full API token despite the retired flag", async () => {
  vi.stubEnv("ELIZA_EXTERNAL_BASE_URL", "https://api.example.test");
  vi.stubEnv("ELIZA_WEB_PUSH_VAPID_PUBLIC_KEY", "public-vapid-fixture");
  const base = await start(apiToken, undefined);
  const response = await fetch(base + "/");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain(apiToken);
  const window: Record<string | symbol, unknown> = {};
  const writes: unknown[] = [];
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    runInNewContext(match[1], {
      window,
      localStorage: {
        getItem: () => null,
        setItem: (...args: unknown[]) => writes.push(args),
      },
    });
  }
  expect(window.__ELIZAOS_APP_BOOT_CONFIG__).toMatchObject({
    apiBase: "https://api.example.test",
    webPushVapidPublicKey: "public-vapid-fixture",
  });
  expect(window.__ELIZAOS_APP_BOOT_CONFIG__).not.toHaveProperty("apiToken");
  expect(window).not.toHaveProperty("__ELIZA_API_TOKEN__");
  expect(writes).toEqual([]);
  expect((await fetch(base + "/api/status")).status).toBe(401);
  expect(
    (
      await fetch(base + "/api/status", {
        headers: { authorization: `Bearer ${apiToken}` },
      })
    ).status,
  ).toBe(200);
});

it("refuses both tokenless loopback stdio configuration surfaces despite the retired flag without changing disk state", async () => {
  const base = await start(undefined, undefined);
  const before = await readFile(configPath, "utf8");
  const plugin = await send(base, "/api/mcp/config/server", {
    name: "rejected",
    config: stdio,
  });
  expect(plugin.status, await plugin.clone().text()).toBe(403);
  const config = await send(
    base,
    "/api/config",
    { mcp: { servers: { rejected: stdio } } },
    "PUT",
  );
  expect(config.status, await config.clone().text()).toBe(403);
  expect(await readFile(configPath, "utf8")).toBe(before);
  const privateUrl = await send(base, "/api/mcp/config/server", {
    name: "private",
    config: { type: "sse", url: "http://127.0.0.1:1/mcp" },
  });
  expect(privateUrl.status, await privateUrl.clone().text()).toBe(400);
  expect(await readFile(configPath, "utf8")).toBe(before);
  const publicHttp = await send(base, "/api/mcp/config/server", {
    name: "public",
    config: { type: "sse", url: "https://93.184.216.34/mcp" },
  });
  expect(publicHttp.status, await publicHttp.clone().text()).toBe(200);
  expect((await stored()).mcp.servers.public.url).toBe(
    "https://93.184.216.34/mcp",
  );
});

it("retains explicit terminal-token authorization and never persists the request credential", async () => {
  const base = await start(undefined, terminalToken);
  const before = await readFile(configPath, "utf8");
  for (const headers of [{}, { "x-eliza-terminal-token": "invalid" }]) {
    const denied = await send(
      base,
      "/api/mcp/config/server",
      { name: "rejected", config: stdio },
      "POST",
      headers,
    );
    expect(denied.status, await denied.clone().text()).toBe(401);
    expect(await readFile(configPath, "utf8")).toBe(before);
  }
  const headerWins = await send(
    base,
    "/api/mcp/config/server",
    { name: "rejected", config: stdio, terminalToken },
    "POST",
    { "x-eliza-terminal-token": "invalid" },
  );
  expect(headerWins.status, await headerWins.clone().text()).toBe(401);
  expect(await readFile(configPath, "utf8")).toBe(before);
  const plugin = await send(base, "/api/mcp/config/server", {
    name: "authorized",
    config: stdio,
    terminalToken,
  });
  expect(plugin.status, await plugin.clone().text()).toBe(200);
  const config = await send(
    base,
    "/api/config",
    { mcp: { servers: { authorizedAgain: stdio } } },
    "PUT",
    { "x-eliza-terminal-token": terminalToken },
  );
  expect(config.status, await config.clone().text()).toBe(200);
  const saved = await stored();
  expect(saved.mcp.servers.authorizedAgain.command).toBe("node");
  expect(JSON.stringify(saved)).not.toContain(terminalToken);
});
