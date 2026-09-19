/**
 * Exercises launch admission with the real client, profile persistence, and a
 * local HTTP receiver. Rejected addresses must leave the previous destination
 * and its authorization intact, including deployments mounted below a prefix.
 */
// @vitest-environment jsdom
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { client } from "../api";
import { loadAgentProfileRegistry } from "../state/agent-profiles";
import { loadPersistedActiveServer } from "../state/persistence";
import { applyLaunchConnection } from "./browser-launch";

let server: Server;
let base: string;
const received: Array<{
  path: string | undefined;
  authorization: string | undefined;
}> = [];

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  received.length = 0;
  server = createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ complete: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP listener");
  base = `http://127.0.0.1:${address.port}/agent/prefix`;
  applyLaunchConnection({
    apiBase: `${base}/`,
    token: "synthetic-existing-owner",
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  client.setToken(null);
  localStorage.clear();
  sessionStorage.clear();
});

it.each([
  "synthetic-user:synthetic-password",
  "synthetic-user",
  ":synthetic-password",
])(
  "rejects URL credentials %s before changing the active connection",
  async (userinfo) => {
    const active = loadPersistedActiveServer();
    const registry = loadAgentProfileRegistry();
    const invalid = new URL(base);
    const [username, password = ""] = userinfo.split(":");
    invalid.username = username;
    invalid.password = password;
    expect(() =>
      applyLaunchConnection({
        apiBase: invalid.toString(),
        token: "synthetic-replacement",
      }),
    ).toThrow("Rejected invalid launch apiBase");
    expect(client.getBaseUrl()).toBe(base);
    expect(loadPersistedActiveServer()).toEqual(active);
    expect(loadAgentProfileRegistry()).toEqual(registry);
    expect(await client.getFirstRunStatus()).toEqual({ complete: true });
    expect(received).toEqual([
      {
        path: "/agent/prefix/api/first-run/status",
        authorization: "Bearer synthetic-existing-owner",
      },
    ]);
  },
);
