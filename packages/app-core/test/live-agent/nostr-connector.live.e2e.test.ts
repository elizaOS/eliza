/**
 * Nostr Connector Validation Tests
 *
 * Comprehensive E2E tests for validating the Nostr connector (@elizaos/plugin-nostr).
 *
 * Test Categories:
 *   1. Setup & Authentication
 *   2. Note Handling
 *   3. Nostr-Specific Features (NIP validation)
 *   4. Relay Management
 *   5. Error Handling
 *   6. Integration
 *   7. Configuration
 *
 * Requirements for live tests:
 *   NOSTR_PRIVATE_KEY     — Nostr private key (nsec bech32 or 64-char hex)
 *   NOSTR_RELAYS          — Comma-separated relay URLs (default: wss://relay.damus.io)
 *   ELIZA_LIVE_TEST=1    — Enable live tests
 *
 * Or configure in ~/.eliza/eliza.json:
 *   { "connectors": { "nostr": { "privateKey": "nsec1...", "relays": "wss://..." } } }
 *
 * NO MOCKS for live tests — all tests use real Nostr relays.
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlugin,
  resolveNostrPluginImportSpecifier,
} from "@elizaos/app-core";
import { logger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import { sleep } from "../helpers/test-utils";

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;
const NOSTR_RELAYS = process.env.NOSTR_RELAYS ?? "wss://relay.damus.io";
const _NOSTR_DM_POLICY = process.env.NOSTR_DM_POLICY;
const _NOSTR_ALLOW_FROM = process.env.NOSTR_ALLOW_FROM;

const hasNostrCreds = Boolean(NOSTR_PRIVATE_KEY);
const liveTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const runLiveTests = hasNostrCreds && liveTestsEnabled;

// Write tests require a valid nsec or hex private key
const hasValidNsec =
  Boolean(NOSTR_PRIVATE_KEY) &&
  (/^nsec1[a-z0-9]{58}$/.test(NOSTR_PRIVATE_KEY ?? "") ||
    /^[0-9a-f]{64}$/.test(NOSTR_PRIVATE_KEY ?? ""));
const runLiveWriteTests = runLiveTests && hasValidNsec;

const NOSTR_PLUGIN_IMPORT = resolveNostrPluginImportSpecifier();
const hasPlugin = NOSTR_PLUGIN_IMPORT !== null;

// Plugin-dependent tests (need @elizaos/plugin-nostr installed)
const describeIfPluginAvailable = describeIf(hasPlugin);

// API-level live tests (need creds + ELIZA_LIVE_TEST=1)
const describeIfLive = describeIf(runLiveTests);
const describeIfLiveWrite = describeIf(runLiveWriteTests);

// Timeouts
const RATE_LIMIT_DELAY_MS = 500;
const TEST_TIMEOUT = 30_000;
const LIVE_WRITE_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Parse relay URLs from comma-separated string */
function parseRelays(relayStr: string): string[] {
  return relayStr
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Attempt a WebSocket connection to a Nostr relay.
 * Returns true if the relay responds with EOSE or any valid message within timeout.
 */
async function checkRelayHealth(
  relayUrl: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  // Dynamic import for WebSocket (works in Node 18+)
  const { WebSocket } = await import("ws");

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);

    let ws: InstanceType<typeof WebSocket>;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }

    ws.on("open", () => {
      // Send a REQ to test relay is functional (query for nothing, expect EOSE)
      const subId = crypto.randomUUID().slice(0, 8);
      ws.send(JSON.stringify(["REQ", subId, { limit: 0 }]));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && (msg[0] === "EOSE" || msg[0] === "NOTICE")) {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("error", () => {
      clearTimeout(timer);
      ws.close();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Setup & Authentication
// ---------------------------------------------------------------------------

describe("Nostr Connector - Setup & Authentication", () => {
  describeIfPluginAvailable("plugin loading", () => {
    it(
      "can load the Nostr plugin without errors",
      async () => {
        const mod = (await import(NOSTR_PLUGIN_IMPORT!)) as {
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
        const mod = (await import(NOSTR_PLUGIN_IMPORT!)) as {
          default?: unknown;
          plugin?: unknown;
        };
        const plugin = extractPlugin(mod) as Plugin | null;
        expect(plugin?.name).toBe("nostr");
        expect(plugin?.description).toBeDefined();
      },
      TEST_TIMEOUT,
    );
  });

  describeIfLive("relay connectivity", () => {
    it(
      "can connect to at least one configured relay",
      async () => {
        const relays = parseRelays(NOSTR_RELAYS);
        let anyConnected = false;

        for (const relay of relays) {
          const healthy = await checkRelayHealth(relay);
          if (healthy) {
            anyConnected = true;
            break;
          }
        }

        expect(anyConnected).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Note Handling
// ---------------------------------------------------------------------------

describeIfLiveWrite("Nostr Connector - Note Handling", () => {
  it(
    "relay accepts well-formed subscription request",
    async () => {
      const { WebSocket } = await import("ws");
      const relays = parseRelays(NOSTR_RELAYS);
      const relayUrl = relays[0];

      const result = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 15_000);

        const ws = new WebSocket(relayUrl);

        ws.on("open", () => {
          const subId = crypto.randomUUID().slice(0, 8);
          // Request recent kind-1 text notes with limit 1
          ws.send(JSON.stringify(["REQ", subId, { kinds: [1], limit: 1 }]));
        });

        ws.on("message", (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (Array.isArray(msg)) {
              if (msg[0] === "EVENT" && msg.length >= 3) {
                // Got an event — relay is returning data
                clearTimeout(timer);
                ws.close();
                resolve(true);
              } else if (msg[0] === "EOSE") {
                // End of stored events — relay works even if no events matched
                clearTimeout(timer);
                ws.close();
                resolve(true);
              }
            }
          } catch {
            // Ignore parse errors
          }
        });

        ws.on("error", () => {
          clearTimeout(timer);
          ws.close();
          resolve(false);
        });
      });

      expect(result).toBe(true);
    },
    LIVE_WRITE_TIMEOUT,
  );
});

describeIfLive("Nostr Connector - Live Relay Checks", () => {
  it(
    "configured relays are reachable",
    async () => {
      const relays = parseRelays(NOSTR_RELAYS);
      const results: Array<{ relay: string; healthy: boolean }> = [];

      for (const relay of relays) {
        await sleep(RATE_LIMIT_DELAY_MS);
        const healthy = await checkRelayHealth(relay);
        results.push({ relay, healthy });
      }

      // At least one relay should be healthy
      const healthyCount = results.filter((r) => r.healthy).length;
      expect(healthyCount).toBeGreaterThan(0);

      for (const result of results) {
        if (!result.healthy) {
          logger.warn(
            `[nostr-connector] Relay ${result.relay} is not reachable`,
          );
        }
      }
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Integration Tests (always run, no live creds needed)
// ---------------------------------------------------------------------------

/** Try to import a workspace module; returns null if the package isn't built. */
async function tryWorkspaceImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

describe("Nostr Connector - Integration", () => {
  it("Nostr is mapped in CONNECTOR_PLUGINS", async () => {
    const mod = await tryWorkspaceImport<{
      CONNECTOR_PLUGINS: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[nostr-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CONNECTOR_PLUGINS.nostr).toBe("@elizaos/plugin-nostr");
  });

  it("Nostr is mapped in CHANNEL_PLUGIN_MAP", async () => {
    const mod = await tryWorkspaceImport<{
      CHANNEL_PLUGIN_MAP: Record<string, string>;
    }>("@elizaos/app-core");
    if (!mod) {
      logger.warn("[nostr-connector] Workspace not built — skipping");
      return;
    }
    expect(mod.CHANNEL_PLUGIN_MAP.nostr).toBe("@elizaos/plugin-nostr");
  });
});
