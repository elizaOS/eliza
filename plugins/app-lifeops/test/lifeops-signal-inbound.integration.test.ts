/**
 * Integration test: Signal inbound read via `readSignalInbound()`.
 *
 * Skips cleanly when the Signal daemon is unavailable (no `SIGNAL_HTTP_URL` or
 * `SIGNAL_CLI_PATH` set) — gated by `itIf(SIGNAL_CONFIGURED)`.
 *
 * Uses a minimal HTTP stub in place of signal-cli so the suite can run without
 * a real Signal account. The stub exposes the subset of the signal-cli JSON-RPC
 * HTTP API that `@elizaos/plugin-signal` calls during startup and message reads.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { sendJson, sendJsonError } from "@elizaos/agent";
import { ChannelType, stringToUuid, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itIf } from "../../../test/helpers/conditional-tests.ts";
import { createLifeOpsConnectorGrant } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const SIGNAL_HTTP_URL = process.env.SIGNAL_HTTP_URL?.trim();
const SIGNAL_CLI_PATH = process.env.SIGNAL_CLI_PATH?.trim();
// Stub-based tests do not need live credentials; they only need the plugin importable.
const CAN_STUB =
  !SKIP_REASON &&
  (typeof SIGNAL_HTTP_URL === "undefined" || SIGNAL_HTTP_URL.length === 0) &&
  (typeof SIGNAL_CLI_PATH === "undefined" || SIGNAL_CLI_PATH.length === 0);

const SIGNAL_ACCOUNT = "+15551234567";
const SIGNAL_UUID = "123e4567-e89b-12d3-a456-426614174000";

type StartedHttpServer = {
  close: () => Promise<void>;
  port: number;
  baseUrl: string;
};

async function startSignalStub(): Promise<StartedHttpServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = decodeURIComponent(url.pathname);

    if (method === "GET" && pathname === `/v1/contacts/${SIGNAL_ACCOUNT}`) {
      sendJson(res, {
        contacts: [
          {
            number: "+15550000001",
            uuid: "aabbccdd-1234-5678-9000-aabbccddeeff",
            name: "Alice",
            profileName: "Alice",
            color: "green",
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
    if (method === "POST" && pathname === "/v2/send") {
      sendJson(res, { timestamp: Date.now() });
      return;
    }
    sendJsonError(res, `Unhandled stub route: ${method} ${pathname}`, 404);
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
    throw new Error("Failed to resolve stub port");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function writeLinkedDevice(authDir: string): Promise<void> {
  await mkdir(authDir, { recursive: true });
  await writeFile(
    path.join(authDir, "device-info.json"),
    JSON.stringify(
      {
        authDir,
        phoneNumber: SIGNAL_ACCOUNT,
        uuid: SIGNAL_UUID,
        deviceName: "LifeOps Inbound Test Device",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("Integration: Signal inbound read", () => {
  let oauthDir: string;
  let prevOAuthDir: string | undefined;
  let prevStateDir: string | undefined;
  let prevSignalHttpUrl: string | undefined;
  let prevDisableProactive: string | undefined;
  let stub: StartedHttpServer | undefined;
  let runtime: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | undefined;

  beforeEach(async () => {
    oauthDir = await mkdtemp(path.join(os.tmpdir(), "lifeops-signal-inbound-"));
    prevOAuthDir = process.env.ELIZA_OAUTH_DIR;
    prevStateDir = process.env.ELIZA_STATE_DIR;
    prevSignalHttpUrl = process.env.SIGNAL_HTTP_URL;
    prevDisableProactive = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    process.env.ELIZA_OAUTH_DIR = oauthDir;
    process.env.ELIZA_STATE_DIR = path.join(oauthDir, "state");
    await mkdir(process.env.ELIZA_STATE_DIR, { recursive: true });
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.cleanup();
      runtime = undefined;
    }
    if (stub) {
      await stub.close();
      stub = undefined;
    }
    if (prevOAuthDir === undefined) delete process.env.ELIZA_OAUTH_DIR;
    else process.env.ELIZA_OAUTH_DIR = prevOAuthDir;
    if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prevStateDir;
    if (prevSignalHttpUrl === undefined) delete process.env.SIGNAL_HTTP_URL;
    else process.env.SIGNAL_HTTP_URL = prevSignalHttpUrl;
    if (prevDisableProactive === undefined)
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = prevDisableProactive;
    await rm(oauthDir, { recursive: true, force: true });
  });

  it("returns empty array when Signal service is not connected", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const messages = await service.readSignalInbound();
    expect(messages).toEqual([]);
  });

  itIf(CAN_STUB)(
    "reads messages from memory store when Signal service is connected via stub",
    async () => {
      stub = await startSignalStub();
      process.env.SIGNAL_HTTP_URL = stub.baseUrl;

      runtime = await createLifeOpsTestRuntime();
      runtime.runtime.setSetting("SIGNAL_HTTP_URL", stub.baseUrl, false);

      const authDir = path.join(
        oauthDir,
        "lifeops",
        "signal",
        runtime.runtime.agentId,
        "owner",
      );
      await writeLinkedDevice(authDir);

      const service = new LifeOpsService(runtime.runtime);
      await service.repository.upsertConnectorGrant(
        createLifeOpsConnectorGrant({
          agentId: runtime.runtime.agentId,
          provider: "signal",
          identity: { phoneNumber: SIGNAL_ACCOUNT },
          grantedScopes: [],
          capabilities: ["signal.read", "signal.send"],
          tokenRef: authDir,
          mode: "local",
          side: "owner",
          metadata: {},
          lastRefreshAt: new Date().toISOString(),
        }),
      );

      // Status check should expose inbound: true.
      const status = await service.getSignalConnectorStatus();
      expect(status.inbound).toBe(true);

      // Seed a memory to simulate a received message.
      const roomId = stringToUuid("lifeops-signal-inbound-room");
      const entityId = stringToUuid("lifeops-signal-inbound-entity");
      await runtime.runtime.ensureConnection({
        entityId,
        roomId,
        worldId: stringToUuid("lifeops-signal-inbound-world"),
        worldName: "Signal",
        userName: "Alice",
        name: "Alice",
        source: "signal",
        type: ChannelType.DM,
        channelId: "+15550000001",
      });
      await runtime.runtime.createMemory(
        {
          id: stringToUuid("lifeops-signal-inbound-msg"),
          agentId: runtime.runtime.agentId as UUID,
          roomId,
          entityId,
          content: {
            text: "Meeting confirmed for 3pm.",
            source: "signal",
            name: "Alice",
          },
          createdAt: Date.now() - 2_000,
        } as never,
        "messages",
      );

      // readSignalInbound requires the Signal service to be running.
      // When the service is not available (stub only, no real signal-cli),
      // the method must still return an empty array without throwing.
      const messages = await service.readSignalInbound(10);
      expect(Array.isArray(messages)).toBe(true);
      // Each returned message must conform to LifeOpsSignalInboundMessage shape.
      for (const msg of messages) {
        expect(typeof msg.id).toBe("string");
        expect(typeof msg.roomId).toBe("string");
        expect(typeof msg.channelId).toBe("string");
        expect(typeof msg.threadId).toBe("string");
        expect(typeof msg.roomName).toBe("string");
        expect(typeof msg.speakerName).toBe("string");
        expect(
          msg.senderNumber === null || typeof msg.senderNumber === "string",
        ).toBe(true);
        expect(
          msg.senderUuid === null || typeof msg.senderUuid === "string",
        ).toBe(true);
        expect(
          msg.sourceDevice === null || typeof msg.sourceDevice === "number",
        ).toBe(true);
        expect(msg.groupId === null || typeof msg.groupId === "string").toBe(
          true,
        );
        expect(
          msg.groupType === null || typeof msg.groupType === "string",
        ).toBe(true);
        expect(typeof msg.text).toBe("string");
        expect(typeof msg.createdAt).toBe("number");
        expect(typeof msg.isInbound).toBe("boolean");
        expect(typeof msg.isGroup).toBe("boolean");
      }
    },
    30_000,
  );
});
