/**
 * Real-server e2e for GET /api/commands.
 *
 * Unlike `commands-routes.test.ts` (which drives `handleCommandsRoutes` with
 * mocked `json`/`error` functions and never opens a socket), this boots an
 * actual `http.createServer`, dispatches the real handler over a real TCP
 * loopback, and `fetch`es it — the same path the dashboard composer and the TUI
 * hit through `ElizaClient.listCommands`. It then asserts the served catalog is
 * exactly the projection of the real `getConnectorCommands` source of truth, so
 * the wire contract for every slash command is exercised end to end (no larp).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ClientCommandAction,
  findCommandByKey,
  getConnectorCommands,
  initForRuntime,
  registerCommand,
  useRuntime,
} from "@elizaos/plugin-commands";
import { afterAll, describe, expect, it } from "vitest";

import { handleCommandsRoutes } from "./commands-routes.ts";

function jsonResponder(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function errorResponder(
  res: http.ServerResponse,
  message: string,
  status = 500,
): void {
  jsonResponder(res, { error: message }, status);
}

const servers: http.Server[] = [];

async function startCommandsServer(
  runtime: { agentId?: string } | null = null,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleCommandsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      json: jsonResponder,
      error: errorResponder,
      runtime: runtime as never,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

interface ServedCommand {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: string;
  acceptsArgs: boolean;
  args: Array<{ name: string; choices?: string[] }>;
  target:
    | { kind: "agent" }
    | { kind: "navigate"; path?: string; tab?: string; viewId?: string }
    | { kind: "client"; clientAction: ClientCommandAction };
  source: string;
}

interface CommandsResponse {
  commands: ServedCommand[];
  surface: string | null;
  agentId: string | null;
  generatedAt: string;
}

describe("GET /api/commands (real loopback server)", () => {
  it("serves every connector command from the real registry projection", async () => {
    const baseUrl = await startCommandsServer();
    const response = await fetch(`${baseUrl}/api/commands?surface=gui`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CommandsResponse;

    // The served set must be exactly the projection of the source of truth.
    const expected = getConnectorCommands("gui");
    const servedNames = body.commands.map((c) => c.key).sort();
    const expectedNames = expected.map((c) => c.name).sort();
    expect(servedNames).toEqual(expectedNames);

    // The catalog is non-trivial — at least the navigation surface + several
    // agent-capability commands must be present.
    expect(body.commands.length).toBeGreaterThanOrEqual(20);
    expect(body.surface).toBe("gui");
    expect(typeof body.generatedAt).toBe("string");
  });

  it("serves runtime-registered commands and respects runtime enablement", async () => {
    initForRuntime("commands-route-agent");
    useRuntime("commands-route-agent");
    const restart = findCommandByKey("restart");
    if (!restart) throw new Error("missing restart command");
    restart.enabled = false;
    registerCommand({
      key: "skill-weather",
      description: "Answer weather questions with the weather skill",
      textAliases: ["/weather"],
      scope: "both",
      category: "skills",
      acceptsArgs: true,
    });

    const baseUrl = await startCommandsServer({
      agentId: "commands-route-agent",
    });
    const response = await fetch(`${baseUrl}/api/commands?surface=gui`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CommandsResponse;
    const keys = new Set(body.commands.map((command) => command.key));

    expect(keys.has("restart")).toBe(false);
    expect(keys.has("skill-weather")).toBe(true);
    expect(body.agentId).toBe("commands-route-agent");
  });

  it("tags every served command with a well-formed, valid target", async () => {
    const baseUrl = await startCommandsServer();
    const body = (await (
      await fetch(`${baseUrl}/api/commands?surface=gui`)
    ).json()) as CommandsResponse;

    for (const command of body.commands) {
      expect(command.key.length).toBeGreaterThan(0);
      expect(command.textAliases[0]).toBe(`/${command.key}`);
      if (command.target.kind === "navigate") {
        // navigate commands resolve to a concrete in-app destination.
        expect(typeof command.target.path).toBe("string");
        expect(command.target.path?.startsWith("/")).toBe(true);
      } else if (command.target.kind === "client") {
        // client commands carry a non-empty client action; the exact set
        // evolves with the catalog, so validate shape, not a frozen allowlist.
        expect(typeof command.target.clientAction).toBe("string");
        expect(command.target.clientAction.length).toBeGreaterThan(0);
      } else {
        expect(command.target.kind).toBe("agent");
      }
    }

    // Representative commands across all three target kinds are present and
    // tagged correctly — the exact effect each client surface dispatches.
    const byKey = new Map(body.commands.map((c) => [c.key, c]));
    expect(byKey.get("settings")?.target).toMatchObject({
      kind: "navigate",
      path: "/settings",
      tab: "settings",
    });
    expect(byKey.get("chat")?.target).toMatchObject({
      kind: "navigate",
      tab: "chat",
    });
    expect(byKey.get("clear")?.target).toMatchObject({
      kind: "client",
      clientAction: "clear-chat",
    });
    expect(byKey.get("fullscreen")?.target).toMatchObject({
      kind: "client",
      clientAction: "toggle-fullscreen",
    });
    // An agent-capability command routes through the message pipeline.
    expect(byKey.get("think")?.target.kind).toBe("agent");
  });

  it("filters local client and navigation commands off chat connectors", async () => {
    const baseUrl = await startCommandsServer();
    const body = (await (
      await fetch(`${baseUrl}/api/commands?surface=discord`)
    ).json()) as CommandsResponse;

    expect(body.surface).toBe("discord");
    const keys = new Set(body.commands.map((c) => c.key));
    // GUI-only client behaviors have no remote surface.
    expect(keys.has("clear")).toBe(false);
    expect(keys.has("fullscreen")).toBe(false);
    // In-app navigation is GUI-only; agent commands remain available remotely.
    expect(keys.has("settings")).toBe(false);
    expect(keys.has("think")).toBe(true);
  });

  it("propagates the runtime agent id and rejects non-GET", async () => {
    const baseUrl = await startCommandsServer({ agentId: "agent-real-server" });
    const getBody = (await (
      await fetch(`${baseUrl}/api/commands`)
    ).json()) as CommandsResponse;
    expect(getBody.agentId).toBe("agent-real-server");
    expect(getBody.surface).toBeNull();

    const post = await fetch(`${baseUrl}/api/commands`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
