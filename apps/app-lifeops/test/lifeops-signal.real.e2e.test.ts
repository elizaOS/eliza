import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentRuntime,
  ChannelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { sendJson, sendJsonError, readJsonBody } from "@elizaos/agent/api/http-helpers";
import { decodePathComponent } from "@elizaos/agent/api/server-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { req } from "../../../../test/helpers/http.ts";
import { createRealTestRuntime } from "../../../../test/helpers/real-runtime.ts";
import { readRecentMessages } from "@elizaos/plugin-signal";
import { crossChannelSendAction } from "../src/actions/cross-channel-send.js";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import type { LifeOpsRouteContext } from "../src/routes/lifeops-routes.js";
import { handleLifeOpsRoutes } from "../src/routes/lifeops-routes.js";
import { appLifeOpsPlugin } from "../src/plugin.js";

const SIGNAL_PHONE = "+15551230000";
const SIGNAL_ACCOUNT = "+15551234567";
const SIGNAL_UUID = "123e4567-e89b-12d3-a456-426614174000";
const SIGNAL_CLI_CANDIDATES = [
  process.env.SIGNAL_CLI_PATH?.trim(),
  "/opt/homebrew/bin/signal-cli",
  "/usr/local/bin/signal-cli",
].filter((candidate): candidate is string => Boolean(candidate));
const SIGNAL_CLI_AVAILABLE = SIGNAL_CLI_CANDIDATES.some((candidate) =>
  fs.existsSync(candidate),
);

type RealRuntimeHandle = Awaited<ReturnType<typeof createRealTestRuntime>>;

type StartedHttpServer = {
  close: () => Promise<void>;
  port: number;
};

type SignalSendPayload = {
  message?: string;
  number?: string;
  recipients?: string[];
};

type SignalStubHandle = StartedHttpServer & {
  baseUrl: string;
  sendPayloads: SignalSendPayload[];
};

type RouteServerHandle = StartedHttpServer;

function ownerMessage(runtime: AgentRuntime, text: string) {
  return {
    id: stringToUuid(`signal-owner-${text}`),
    roomId: stringToUuid(`signal-owner-room-${text}`),
    entityId: runtime.agentId as UUID,
    agentId: runtime.agentId as UUID,
    content: {
      text,
      source: "dashboard",
    },
    createdAt: Date.now(),
  } as const;
}

async function readJsonFromRequest(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<StartedHttpServer> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.writableEnded) {
        sendJsonError(
          res,
          error instanceof Error ? error.message : String(error),
          500,
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server port");
  }

  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startSignalHttpStub(): Promise<SignalStubHandle> {
  const sendPayloads: SignalSendPayload[] = [];
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === `/v1/contacts/${SIGNAL_ACCOUNT}`) {
      sendJson(res, {
        contacts: [
          {
            number: SIGNAL_PHONE,
            uuid: SIGNAL_UUID,
            name: "Dana",
            profileName: "Dana",
            color: "blue",
            blocked: false,
          },
        ],
      });
      return;
    }

    if (method === "GET" && pathname === `/v1/groups/${SIGNAL_ACCOUNT}`) {
      sendJson(res, []);
      return;
    }

    if (method === "GET" && pathname === `/v1/receive/${SIGNAL_ACCOUNT}`) {
      sendJson(res, []);
      return;
    }

    if (method === "POST" && url.pathname === "/v2/send") {
      const body = (await readJsonFromRequest(req)) as SignalSendPayload;
      sendPayloads.push(body);
      sendJson(res, { timestamp: Date.now() });
      return;
    }

    sendJsonError(res, `Unhandled Signal stub route: ${method} ${url.pathname}`, 404);
  });

  return {
    ...server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    sendPayloads,
  };
}

async function startLifeOpsRouteServer(
  runtime: AgentRuntime,
): Promise<RouteServerHandle> {
  return startServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ctx: LifeOpsRouteContext = {
      req,
      res,
      method: (req.method ?? "GET").toUpperCase(),
      pathname: url.pathname,
      url,
      state: {
        runtime,
        adminEntityId: null,
      },
      json: (response, data, status) => {
        sendJson(response, data, status);
      },
      error: (response, message, status) => {
        sendJsonError(response, message, status);
      },
      readJsonBody,
      decodePathComponent,
    };

    const handled = await handleLifeOpsRoutes(ctx);
    if (!handled && !res.writableEnded) {
      sendJsonError(
        res,
        `Unhandled LifeOps route: ${ctx.method} ${ctx.pathname}`,
        404,
      );
    }
  });
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await read();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  let renderedLastValue = String(lastValue);
  try {
    renderedLastValue = JSON.stringify(lastValue);
  } catch {
    renderedLastValue = Object.prototype.toString.call(lastValue);
  }
  throw new Error(`${label} timed out. Last value: ${renderedLastValue}`);
}

async function writeLinkedSignalDevice(
  authDir: string,
  phoneNumber = SIGNAL_ACCOUNT,
): Promise<void> {
  await mkdir(authDir, { recursive: true });
  await writeFile(
    path.join(authDir, "device-info.json"),
    JSON.stringify(
      {
        authDir,
        phoneNumber,
        uuid: SIGNAL_UUID,
        deviceName: "LifeOps Test Device",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function seedSignalGrant(runtime: AgentRuntime, authDir: string): Promise<void> {
  const service = new LifeOpsService(runtime);
  await service.repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "signal",
      identity: {
        phoneNumber: SIGNAL_ACCOUNT,
      },
      grantedScopes: [],
      capabilities: ["signal.read", "signal.send"],
      tokenRef: authDir,
      mode: "local",
      side: "owner",
      metadata: {},
      lastRefreshAt: new Date().toISOString(),
    }),
  );
}

async function seedSignalMemory(runtime: AgentRuntime): Promise<void> {
  const roomId = stringToUuid("lifeops-signal-room");
  const entityId = stringToUuid("lifeops-signal-user");
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: stringToUuid("lifeops-signal-world"),
    worldName: "Signal",
    userName: "Dana",
    name: "Dana",
    source: "signal",
    type: ChannelType.DM,
    channelId: SIGNAL_PHONE,
  });
  await runtime.createMemory(
    {
      id: stringToUuid("lifeops-signal-memory"),
      agentId: runtime.agentId as UUID,
      roomId,
      entityId,
      content: {
        text: "Booking confirmed.",
        source: "signal",
        name: "Dana",
      },
      createdAt: Date.now() - 1_000,
    } as never,
    "messages",
  );
}

describe("Real E2E: LifeOps Signal", () => {
  let oauthDir: string;
  let stateDir: string;
  let configPath: string;
  let previousOAuthDir: string | undefined;
  let previousStateDir: string | undefined;
  let previousConfigPath: string | undefined;
  let previousPersistConfigPath: string | undefined;
  let previousDisableProactiveAgent: string | undefined;
  let previousDisableLifeOpsScheduler: string | undefined;
  let previousSignalHttpUrl: string | undefined;
  let runtimeHandle: RealRuntimeHandle | undefined;
  let routeServer: RouteServerHandle | undefined;
  let signalStub: SignalStubHandle | undefined;

  async function createLifeOpsRuntime(): Promise<RealRuntimeHandle> {
    const handle = await createRealTestRuntime({
      plugins: [appLifeOpsPlugin],
    });
    await LifeOpsRepository.bootstrapSchema(handle.runtime);
    return handle;
  }

  beforeEach(async () => {
    oauthDir = await mkdtemp(path.join(os.tmpdir(), "lifeops-signal-oauth-"));
    stateDir = path.join(oauthDir, "state");
    configPath = path.join(stateDir, "eliza.json");
    await mkdir(stateDir, { recursive: true });
    previousOAuthDir = process.env.ELIZA_OAUTH_DIR;
    previousStateDir = process.env.ELIZA_STATE_DIR;
    previousConfigPath = process.env.ELIZA_CONFIG_PATH;
    previousPersistConfigPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
    previousDisableProactiveAgent = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    previousDisableLifeOpsScheduler =
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    previousSignalHttpUrl = process.env.SIGNAL_HTTP_URL;
    process.env.ELIZA_OAUTH_DIR = oauthDir;
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
  });

  afterEach(async () => {
    if (routeServer) {
      await routeServer.close();
      routeServer = undefined;
    }
    if (runtimeHandle) {
      await runtimeHandle.cleanup();
      runtimeHandle = undefined;
    }
    if (signalStub) {
      await signalStub.close();
      signalStub = undefined;
    }
    if (previousOAuthDir === undefined) {
      delete process.env.ELIZA_OAUTH_DIR;
    } else {
      process.env.ELIZA_OAUTH_DIR = previousOAuthDir;
    }
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.ELIZA_CONFIG_PATH;
    } else {
      process.env.ELIZA_CONFIG_PATH = previousConfigPath;
    }
    if (previousPersistConfigPath === undefined) {
      delete process.env.ELIZA_PERSIST_CONFIG_PATH;
    } else {
      process.env.ELIZA_PERSIST_CONFIG_PATH = previousPersistConfigPath;
    }
    if (previousDisableProactiveAgent === undefined) {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    } else {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT = previousDisableProactiveAgent;
    }
    if (previousDisableLifeOpsScheduler === undefined) {
      delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    } else {
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER =
        previousDisableLifeOpsScheduler;
    }
    if (previousSignalHttpUrl === undefined) {
      delete process.env.SIGNAL_HTTP_URL;
    } else {
      process.env.SIGNAL_HTTP_URL = previousSignalHttpUrl;
    }
    await rm(oauthDir, { recursive: true, force: true });
  });

  itIf(SIGNAL_CLI_AVAILABLE)(
    "starts and stops a Signal pairing session through the LifeOps routes",
    async () => {
      runtimeHandle = await createLifeOpsRuntime();
      routeServer = await startLifeOpsRouteServer(runtimeHandle.runtime);

      const pairResponse = await req(
        routeServer.port,
        "POST",
        "/api/lifeops/connectors/signal/pair",
        {},
      );
      expect(pairResponse.status).toBe(201);
      expect(pairResponse.data.provider).toBe("signal");
      expect(typeof pairResponse.data.sessionId).toBe("string");
      const sessionId = String(pairResponse.data.sessionId);

      const pairingStatus = await waitFor(
        "Signal pairing status",
        async () =>
          req(
            routeServer!.port,
            "GET",
            `/api/lifeops/connectors/signal/pairing-status?sessionId=${encodeURIComponent(sessionId)}`,
          ),
        (response) =>
          response.status === 200 &&
          response.data.state === "waiting_for_scan" &&
          typeof response.data.qrDataUrl === "string",
        45_000,
      );
      expect(String(pairingStatus.data.qrDataUrl)).toContain(
        "data:image/png;base64,",
      );

      const statusResponse = await req(
        routeServer.port,
        "GET",
        "/api/lifeops/connectors/signal/status",
      );
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.data.reason).toBe("pairing");
      expect(statusResponse.data.connected).toBe(false);

      const stopResponse = await req(
        routeServer.port,
        "POST",
        "/api/lifeops/connectors/signal/stop",
        {},
      );
      expect(stopResponse.status).toBe(200);
      expect(stopResponse.data.state).toBe("idle");

      const disconnectResponse = await req(
        routeServer.port,
        "POST",
        "/api/lifeops/connectors/signal/disconnect",
        {},
      );
      expect(disconnectResponse.status).toBe(200);
      expect(disconnectResponse.data.connected).toBe(false);
      expect(disconnectResponse.data.reason).toBe("disconnected");
    },
    90_000,
  );

  it(
    "hydrates a connected Signal grant, reads recent messages, and sends through LifeOps",
    async () => {
      signalStub = await startSignalHttpStub();
      process.env.SIGNAL_HTTP_URL = signalStub.baseUrl;

      runtimeHandle = await createLifeOpsRuntime();
      runtimeHandle.runtime.setSetting("SIGNAL_HTTP_URL", signalStub.baseUrl, false);
      routeServer = await startLifeOpsRouteServer(runtimeHandle.runtime);

      const authDir = path.join(oauthDir, "lifeops", "signal", "agent", "owner");
      await writeLinkedSignalDevice(authDir);
      await seedSignalGrant(runtimeHandle.runtime, authDir);

      const statusResponse = await req(
        routeServer.port,
        "GET",
        "/api/lifeops/connectors/signal/status",
      );
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.data.connected).toBe(true);
      expect(statusResponse.data.reason).toBe("connected");
      expect(statusResponse.data.identity).toMatchObject({
        phoneNumber: SIGNAL_ACCOUNT,
        uuid: SIGNAL_UUID,
      });
      expect(statusResponse.data.grantedCapabilities).toEqual(
        expect.arrayContaining(["signal.read", "signal.send"]),
      );

      const signalService = (await runtimeHandle.runtime.getServiceLoadPromise(
        "signal",
      )) as {
        isServiceConnected?: () => boolean;
      } | null;
      expect(signalService?.isServiceConnected?.()).toBe(true);

      await seedSignalMemory(runtimeHandle.runtime);

      const readCallback = vi.fn();
      const readResult = await readRecentMessages.handler?.(
        runtimeHandle.runtime,
        ownerMessage(runtimeHandle.runtime, "Check my Signal messages"),
        undefined,
        undefined,
        readCallback,
      );
      expect(readResult).toMatchObject({
        success: true,
        data: expect.objectContaining({
          messageCount: 1,
        }),
      });
      expect(readCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Booking confirmed."),
        }),
      );

      const draftResult = await crossChannelSendAction.handler?.(
        runtimeHandle.runtime,
        ownerMessage(runtimeHandle.runtime, "draft signal send"),
        undefined,
        {
          parameters: {
            channel: "signal",
            target: SIGNAL_PHONE,
            message: "On my way.",
            confirmed: false,
          },
        } as never,
      );
      expect(draftResult).toMatchObject({
        success: true,
        values: expect.objectContaining({
          draft: true,
          channel: "signal",
        }),
      });
      expect(signalStub.sendPayloads).toHaveLength(0);

      const sendResult = await crossChannelSendAction.handler?.(
        runtimeHandle.runtime,
        ownerMessage(runtimeHandle.runtime, "confirm signal send"),
        undefined,
        {
          parameters: {
            channel: "signal",
            target: SIGNAL_PHONE,
            message: "On my way.",
            confirmed: true,
          },
        } as never,
      );
      expect(sendResult).toMatchObject({
        success: true,
        values: expect.objectContaining({
          channel: "signal",
          target: SIGNAL_PHONE,
        }),
      });

      expect(signalStub.sendPayloads).toHaveLength(1);
      expect(signalStub.sendPayloads[0]).toMatchObject({
        message: "On my way.",
        number: SIGNAL_ACCOUNT,
        recipients: [SIGNAL_PHONE],
      });
    },
    45_000,
  );
});
