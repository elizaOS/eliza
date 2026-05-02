/**
 * Matrix Connector Validation Tests
 *
 * Comprehensive E2E tests for validating the Matrix connector (@elizaos/plugin-matrix).
 *
 * Test Categories:
 *   1. Setup & Authentication
 *   2. Message Handling
 *   3. Matrix-Specific Features
 *   4. Rooms & Spaces
 *   5. Error Handling
 *   6. Integration
 *   7. Configuration
 *
 * Requirements for live tests:
 *   MATRIX_ACCESS_TOKEN   — Matrix access token
 *   MATRIX_HOMESERVER     — Matrix homeserver URL (e.g., https://matrix.org)
 *   MATRIX_USER_ID        — Matrix user ID (e.g., @agent:example.com)
 *   ELIZA_LIVE_TEST=1    — Enable live tests
 *
 * Additional env vars for write tests:
 *   MATRIX_ROOMS          — Comma-separated room IDs to test in
 *
 * Or configure in ~/.eliza/eliza.json:
 *   { "connectors": { "matrix": { "token": "...", "homeserver": "...", "userId": "..." } } }
 *
 * NO MOCKS for live tests — all tests use real Matrix Client-Server API.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlugin,
  resolveMatrixPluginImportSpecifier,
} from "@elizaos/app-core";
import { logger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import { sleep } from "../helpers/test-utils";

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER ?? "https://matrix.org";
const MATRIX_USER_ID = process.env.MATRIX_USER_ID;
const _MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID;
const MATRIX_ROOMS = process.env.MATRIX_ROOMS;

const hasMatrixCreds = Boolean(MATRIX_ACCESS_TOKEN && MATRIX_HOMESERVER);
const liveTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const runLiveTests = hasMatrixCreds && liveTestsEnabled;

// Write tests require at least one target room
const hasRoomTargets = Boolean(MATRIX_ROOMS);
const runLiveWriteTests = runLiveTests && hasRoomTargets;

const MATRIX_PLUGIN_IMPORT = resolveMatrixPluginImportSpecifier();
const hasPlugin = MATRIX_PLUGIN_IMPORT !== null;

// Plugin-dependent tests (need @elizaos/plugin-matrix installed)
const describeIfPluginAvailable = describeIf(hasPlugin);

// API-level live tests (need creds + ELIZA_LIVE_TEST=1)
const describeIfLive = describeIf(runLiveTests);
const describeIfLiveWrite = describeIf(runLiveWriteTests);

// Timeouts
const RATE_LIMIT_DELAY_MS = 500;
const TEST_TIMEOUT = 30_000;
const LIVE_WRITE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Parse room IDs from comma-separated string */
function parseRooms(roomStr: string): string[] {
  return roomStr
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** GET request against the Matrix Client-Server API */
async function matrixGet<T>(
  endpoint: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = `${MATRIX_HOMESERVER}/_matrix/client/v3/${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

/** PUT request against the Matrix Client-Server API */
async function matrixPut<T>(
  endpoint: string,
  accessToken: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = `${MATRIX_HOMESERVER}/_matrix/client/v3/${endpoint}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

/**
 * Check whether a Matrix homeserver is reachable.
 * Returns true if the login endpoint responds.
 */
async function checkHomeserverHealth(
  homeserver: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await res.json()) as { flows?: unknown[] };
    return res.ok && Array.isArray(data.flows);
  } catch {
    return false;
  }
}

// Track sent event IDs for cleanup
const sentEventIds: string[] = [];
let testRoomId: string | undefined;

beforeAll(() => {
  if (MATRIX_ROOMS) {
    const rooms = parseRooms(MATRIX_ROOMS);
    testRoomId = rooms[0];
  }
});

afterAll(async () => {
  // Best-effort cleanup: redact test messages
  if (sentEventIds.length > 0 && testRoomId && MATRIX_ACCESS_TOKEN) {
    for (const eventId of sentEventIds) {
      try {
        await matrixPut(
          `rooms/${encodeURIComponent(testRoomId)}/redact/${encodeURIComponent(eventId)}/${crypto.randomUUID()}`,
          MATRIX_ACCESS_TOKEN,
          { reason: "eliza test cleanup" },
        );
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Setup & Authentication
// ---------------------------------------------------------------------------

describe("Matrix Connector - Setup & Authentication", () => {
  describeIfPluginAvailable("plugin loading", () => {
    it(
      "can load the Matrix plugin without errors",
      async () => {
        const mod = (await import(MATRIX_PLUGIN_IMPORT!)) as {
          default?: unknown;
          plugin?: unknown;
        };
        const plugin = extractPlugin(mod);
        expect(plugin).not.toBeNull();
      },
      TEST_TIMEOUT,
    );

    it(
      "plugin exports expected structure",
      async () => {
        const mod = (await import(MATRIX_PLUGIN_IMPORT!)) as {
          default?: unknown;
          plugin?: unknown;
        };
        const plugin = extractPlugin(mod) as Plugin | null;
        expect(plugin?.name).toBe("matrix");
        expect(plugin?.description).toBeDefined();
      },
      TEST_TIMEOUT,
    );
  });

  describeIfLive("homeserver connectivity", () => {
    it(
      "homeserver is reachable",
      async () => {
        const healthy = await checkHomeserverHealth(MATRIX_HOMESERVER);
        expect(healthy).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "access token authenticates successfully",
      async () => {
        const { ok, data } = await matrixGet<{ user_id: string }>(
          "account/whoami",
          MATRIX_ACCESS_TOKEN!,
        );
        expect(ok).toBe(true);
        expect(data.user_id).toBeDefined();
        expect(typeof data.user_id).toBe("string");
      },
      TEST_TIMEOUT,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Message Handling
// ---------------------------------------------------------------------------

describeIfLiveWrite("Matrix Connector - Message Handling", () => {
  it(
    "can send a text message",
    async () => {
      const txnId = crypto.randomUUID();
      const { ok, data } = await matrixPut<{ event_id: string }>(
        `rooms/${encodeURIComponent(testRoomId!)}/send/m.room.message/${txnId}`,
        MATRIX_ACCESS_TOKEN!,
        {
          msgtype: "m.text",
          body: `[eliza-test] text message at ${new Date().toISOString()}`,
        },
      );

      expect(ok).toBe(true);
      expect(data.event_id).toBeDefined();
      expect(data.event_id.startsWith("$")).toBe(true);
      sentEventIds.push(data.event_id);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can send an m.notice message",
    async () => {
      const txnId = crypto.randomUUID();
      const { ok, data } = await matrixPut<{ event_id: string }>(
        `rooms/${encodeURIComponent(testRoomId!)}/send/m.room.message/${txnId}`,
        MATRIX_ACCESS_TOKEN!,
        {
          msgtype: "m.notice",
          body: `[eliza-test] notice at ${new Date().toISOString()}`,
        },
      );

      expect(ok).toBe(true);
      expect(data.event_id).toBeDefined();
      sentEventIds.push(data.event_id);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "can read room messages",
    async () => {
      await sleep(RATE_LIMIT_DELAY_MS);
      const { ok, data } = await matrixGet<{
        chunk: Array<{
          type: string;
          content: Record<string, unknown>;
          sender: string;
          event_id: string;
          room_id: string;
        }>;
      }>(
        `rooms/${encodeURIComponent(testRoomId!)}/messages?dir=b&limit=5`,
        MATRIX_ACCESS_TOKEN!,
      );

      expect(ok).toBe(true);
      expect(Array.isArray(data.chunk)).toBe(true);
    },
    LIVE_WRITE_TIMEOUT,
  );

  it(
    "message events have correct structure",
    async () => {
      await sleep(RATE_LIMIT_DELAY_MS);
      const { ok, data } = await matrixGet<{
        chunk: Array<{
          type: string;
          content: Record<string, unknown>;
          sender: string;
          event_id: string;
          room_id: string;
        }>;
      }>(
        `rooms/${encodeURIComponent(testRoomId!)}/messages?dir=b&limit=5`,
        MATRIX_ACCESS_TOKEN!,
      );

      expect(ok).toBe(true);
      if (data.chunk && data.chunk.length > 0) {
        const event = data.chunk[0];
        expect(event.type).toBeDefined();
        expect(event.sender).toBeDefined();
        expect(event.event_id).toBeDefined();
        expect(event.event_id.startsWith("$")).toBe(true);
      }
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Matrix-Specific Features
// ---------------------------------------------------------------------------

describeIfLiveWrite("Matrix Connector - Live Matrix Features", () => {
  it(
    "can send typing indicator",
    async () => {
      const userId = MATRIX_USER_ID ?? "";
      const { ok } = await matrixPut<Record<string, unknown>>(
        `rooms/${encodeURIComponent(testRoomId!)}/typing/${encodeURIComponent(userId)}`,
        MATRIX_ACCESS_TOKEN!,
        { typing: true, timeout: 5000 },
      );

      expect(ok).toBe(true);
    },
    LIVE_WRITE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 4. Rooms & Spaces
// ---------------------------------------------------------------------------

describeIfLive("Matrix Connector - Rooms & Spaces", () => {
  it(
    "can list joined rooms",
    async () => {
      const { ok, data } = await matrixGet<{
        joined_rooms: string[];
      }>("joined_rooms", MATRIX_ACCESS_TOKEN!);

      expect(ok).toBe(true);
      expect(Array.isArray(data.joined_rooms)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "room IDs have correct format",
    async () => {
      const { ok, data } = await matrixGet<{
        joined_rooms: string[];
      }>("joined_rooms", MATRIX_ACCESS_TOKEN!);

      expect(ok).toBe(true);
      const roomIdPattern = /^![A-Za-z0-9]+:[a-z0-9.-]+$/;
      for (const roomId of data.joined_rooms) {
        expect(roomIdPattern.test(roomId)).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );
});

describeIfLive("Matrix Connector - Live Error Handling", () => {
  it(
    "invalid access token returns 401",
    async () => {
      const { ok, status, data } = await matrixGet<{
        errcode: string;
        error: string;
      }>("account/whoami", "INVALID_TOKEN_VALUE");

      expect(ok).toBe(false);
      expect(status).toBe(401);
      expect(data.errcode).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "non-existent room returns error",
    async () => {
      await sleep(RATE_LIMIT_DELAY_MS);
      const { ok } = await matrixGet<{
        errcode: string;
      }>(
        `rooms/${encodeURIComponent("!nonexistent:example.com")}/messages?dir=b&limit=1`,
        MATRIX_ACCESS_TOKEN!,
      );

      expect(ok).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 6. Integration Tests (always run, no live creds needed)
// ---------------------------------------------------------------------------

/** Try to import a workspace module; returns null if the package isn't built. */
async function tryWorkspaceImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

describe("Matrix Connector - Integration", () => {
  it("Matrix is mapped in CONNECTOR_PLUGINS", async () => {
    const mod = await tryWorkspaceImport<{
      CONNECTOR_PLUGINS: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[matrix-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CONNECTOR_PLUGINS.matrix).toBe("@elizaos/plugin-matrix");
  });

  it("Matrix is mapped in CHANNEL_PLUGIN_MAP", async () => {
    let mod: { CHANNEL_PLUGIN_MAP: Record<string, string> } | null;
    try {
      mod = await tryWorkspaceImport<{
        CHANNEL_PLUGIN_MAP: Record<string, string>;
      }>("@elizaos/app-core");
    } catch {
      mod = null;
    }
    if (!mod) {
      logger.warn("[matrix-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CHANNEL_PLUGIN_MAP.matrix).toBe("@elizaos/plugin-matrix");
  });
});
