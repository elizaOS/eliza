/**
 * Shell and code custom actions use the terminal action's execution gate: on a
 * store build they cannot be created, updated, tested or run, and saved ones
 * are not registered. They default to OWNER, and code actions do not receive
 * host-realm objects.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CustomActionDef } from "@elizaos/contracts";
import type { Action, IAgentRuntime } from "@elizaos/core";
import {
  _resetBuildVariantForTests,
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  handleMiscRoutes,
  type MiscRouteContext,
} from "../src/api/misc-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import {
  buildTestHandler,
  registerCustomActionLive,
  registerSavedCustomActions,
  setCustomActionsRuntime,
} from "../src/runtime/custom-actions.ts";

let dir: string;
let server: http.Server | undefined;
let baseUrl: string;
let actions: Action[];

function codeAction(overrides: Partial<CustomActionDef> = {}): CustomActionDef {
  return {
    id: randomUUID(),
    name: "ADD_NUMBERS",
    description: "Add two numbers",
    similes: [],
    parameters: [],
    handler: { type: "code", code: "return 'ran';" },
    enabled: true,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

function useBuildVariant(variant: "store" | "direct"): void {
  vi.stubEnv("ELIZA_BUILD_VARIANT", variant);
  _resetBuildVariantForTests();
}

async function startServer(): Promise<void> {
  const state = { config: loadElizaConfig(), shellEnabled: true };
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMiscRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      state: state as unknown as MiscRouteContext["state"],
      json: sendJson,
      error: sendJsonError,
      readJsonBody,
      resolveTerminalRunRejection: () => null,
    } as unknown as MiscRouteContext).then((handled) => {
      if (!handled) sendJsonError(res, "not found", 404);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function send(
  method: string,
  pathname: string,
  body: unknown,
): Promise<number> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "custom-actions-gate-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  actions = [];
  setCustomActionsRuntime({
    actions,
    registerAction: (action: Action) => actions.push(action),
    unregisterAction: (name: string) => {
      const index = actions.findIndex((action) => action.name === name);
      if (index === -1) return false;
      actions.splice(index, 1);
      return true;
    },
  } as unknown as IAgentRuntime);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  vi.unstubAllEnvs();
  _resetBuildVariantForTests();
  await rm(dir, { recursive: true, force: true });
});

it("refuses to create, update or test code actions on a store build", async () => {
  const saved = codeAction({
    handler: { type: "http", method: "GET", url: "https://example.com/" },
    enabled: false,
  });
  const savedCode = codeAction({ enabled: false });
  saveElizaConfig({ customActions: [saved, savedCode] });
  useBuildVariant("store");
  await startServer();

  expect(
    await send("POST", "/api/custom-actions", {
      name: "add numbers",
      description: "Add two numbers",
      handler: { type: "code", code: "return 1;" },
      enabled: true,
    }),
  ).toBe(403);
  expect(
    await send("PUT", `/api/custom-actions/${saved.id}`, {
      handler: { type: "shell", command: "echo hi" },
    }),
  ).toBe(403);
  expect(
    await send("POST", `/api/custom-actions/${savedCode.id}/test`, {
      params: {},
    }),
  ).toBe(403);
  expect(loadElizaConfig().customActions?.map((a) => a.handler.type)).toEqual([
    "http",
    "code",
  ]);
});

it("does not run or register code actions on a store build", async () => {
  const def = codeAction();
  const action = registerCustomActionLive(def);
  useBuildVariant("store");
  const result = await action?.handler(
    {} as IAgentRuntime,
    {} as never,
    undefined,
    { parameters: {} },
  );
  expect(result).toMatchObject({ success: false });
  expect((result as { text: string }).text).toContain("direct download");

  actions.length = 0;
  saveElizaConfig({
    customActions: [
      def,
      codeAction({
        name: "PING_STATUS",
        handler: { type: "http", method: "GET", url: "https://example.com/" },
      }),
    ],
  });
  registerSavedCustomActions();
  expect(actions.map((a) => a.name)).toEqual(["PING_STATUS"]);
});

it("defaults shell and code actions to OWNER and keeps http at USER", () => {
  const code = registerCustomActionLive(codeAction());
  const shell = registerCustomActionLive(
    codeAction({
      name: "CHECK_DISK",
      handler: { type: "shell", command: "df -h" },
    }),
  );
  const httpAction = registerCustomActionLive(
    codeAction({
      name: "PING_STATUS",
      handler: { type: "http", method: "GET", url: "https://example.com/" },
    }),
  );
  const explicit = registerCustomActionLive(
    codeAction({ name: "EXPLICIT_ROLE", requiredRole: "ADMIN" }),
  );
  expect(code?.roleGate).toEqual({ minRole: "OWNER" });
  expect(shell?.roleGate).toEqual({ minRole: "OWNER" });
  expect(httpAction?.roleGate).toEqual({ minRole: "USER" });
  expect(explicit?.roleGate).toEqual({ minRole: "ADMIN" });
});

it("gives code actions params from the script's own realm", async () => {
  const run = buildTestHandler(
    codeAction({
      parameters: [{ name: "a", description: "a", required: true }],
      handler: {
        type: "code",
        code: "return [params.a, Object.isFrozen(params)].join(',');",
      },
    }),
  );
  expect(await run({ a: "7" })).toEqual({ ok: true, output: "7,true" });
  const reachForProcess = buildTestHandler(
    codeAction({
      handler: {
        type: "code",
        code: "return params.constructor.constructor('return process')().version;",
      },
    }),
  );
  await expect(reachForProcess({})).rejects.toThrow(/process is not defined/);
});
