/**
 * Proves the boot-critical auth/token/port env reads migrated to `readAliasedEnv`
 * (#13422 P3) resolve a NON-ELIZA brand prefix (MILADY_*) through the boot-config
 * alias table WITHOUT the `syncBrandEnvToEliza` mirror mutation, and that a present
 * canonical `ELIZA_*` value still wins over the branded alias. Drives the real
 * exported helpers (`resolveCorsOrigin`, `pairingEnabled`, `resolveTerminalRunRejection`,
 * `extractAuthToken`, `isWebSocketAuthorized`, `resolveWalletExportRejection`,
 * `resolveMcpTerminalAuthorizationRejection`) against a live `process.env`; the
 * server.ts/tui/chat-routes port + chat-timeout reads are covered through the same
 * `readAliasedEnv` primitive they call plus the alias-aware `resolveDesktopApiPort`.
 */
import type http from "node:http";
import {
  buildBrandEnvAliases,
  getBootConfig,
  readAliasedEnv,
  resolveDesktopApiPort,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractAuthToken,
  isWebSocketAuthorized,
  pairingEnabled,
  resolveCorsOrigin,
  resolveTerminalRunRejection,
} from "./server-helpers-auth.ts";
import { resolveMcpTerminalAuthorizationRejection } from "./server-helpers-mcp.ts";
import { resolveWalletExportRejection } from "./server-helpers-wallet.ts";

const MILADY_ALIASES = buildBrandEnvAliases("MILADY");

// Every canonical + branded key any test below touches. Snapshotted and cleared
// around each test so a leaked value can never make an alias read pass by mirror.
const TOUCHED_ENV_KEYS = [
  "MILADY_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_PROVISIONED",
  "MILADY_PAIRING_DISABLED",
  "ELIZA_PAIRING_DISABLED",
  "MILADY_TERMINAL_RUN_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "MILADY_WALLET_EXPORT_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "MILADY_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "MILADY_API_PORT",
  "ELIZA_API_PORT",
  "MILADY_CHAT_GENERATION_TIMEOUT_MS",
  "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
  "MILADY_API_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZA_API_BIND",
  "ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP",
] as const;

function asReq(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe("#13422 P3 — alias-aware boot-critical env reads", () => {
  const savedConfig = getBootConfig();
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    setBootConfig({ ...savedConfig, envAliases: MILADY_ALIASES });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  describe("resolveCorsOrigin — ELIZA_CLOUD_PROVISIONED", () => {
    it("allows any origin from the branded MILADY_CLOUD_PROVISIONED flag without writing the ELIZA mirror", () => {
      process.env.MILADY_CLOUD_PROVISIONED = "1";
      expect(resolveCorsOrigin("https://dashboard.milady.example")).toBe(
        "https://dashboard.milady.example",
      );
      expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    });

    it("lets a present canonical ELIZA_CLOUD_PROVISIONED win over the branded alias", () => {
      process.env.ELIZA_CLOUD_PROVISIONED = "0";
      process.env.MILADY_CLOUD_PROVISIONED = "1";
      // ELIZA "0" wins → allow-all is OFF → a non-local origin is rejected.
      expect(resolveCorsOrigin("https://dashboard.milady.example")).toBeNull();
    });
  });

  describe("pairingEnabled — ELIZA_PAIRING_DISABLED", () => {
    it("is disabled by the branded MILADY_PAIRING_DISABLED flag without writing the ELIZA mirror", () => {
      process.env.ELIZA_API_TOKEN = "pairing-api-token";
      process.env.MILADY_PAIRING_DISABLED = "1";
      expect(pairingEnabled()).toBe(false);
      expect(process.env.ELIZA_PAIRING_DISABLED).toBeUndefined();
    });

    it("lets a present canonical ELIZA_PAIRING_DISABLED=0 win over the branded disable flag", () => {
      process.env.ELIZA_API_TOKEN = "pairing-api-token";
      process.env.ELIZA_PAIRING_DISABLED = "0";
      process.env.MILADY_PAIRING_DISABLED = "1";
      expect(pairingEnabled()).toBe(true);
    });
  });

  describe("resolveTerminalRunRejection — ELIZA_TERMINAL_RUN_TOKEN", () => {
    it("authorizes against the branded MILADY_TERMINAL_RUN_TOKEN without writing the ELIZA mirror", () => {
      process.env.MILADY_TERMINAL_RUN_TOKEN = "milady-terminal-secret";
      expect(
        resolveTerminalRunRejection(asReq(), {
          terminalToken: "milady-terminal-secret",
        }),
      ).toBeNull();
      expect(
        resolveTerminalRunRejection(asReq(), { terminalToken: "wrong" }),
      ).toEqual({ status: 401, reason: "Invalid terminal token." });
      expect(process.env.ELIZA_TERMINAL_RUN_TOKEN).toBeUndefined();
    });

    it("lets a present canonical ELIZA_TERMINAL_RUN_TOKEN win over the branded alias", () => {
      process.env.ELIZA_TERMINAL_RUN_TOKEN = "canonical-terminal-secret";
      process.env.MILADY_TERMINAL_RUN_TOKEN = "brand-terminal-secret";
      expect(
        resolveTerminalRunRejection(asReq(), {
          terminalToken: "canonical-terminal-secret",
        }),
      ).toBeNull();
      // the branded value is NOT the expected secret when ELIZA_ is present
      expect(
        resolveTerminalRunRejection(asReq(), {
          terminalToken: "brand-terminal-secret",
        }),
      ).toEqual({ status: 401, reason: "Invalid terminal token." });
    });
  });

  describe("WS/SSE query token gate — ELIZA_ALLOW_WS_QUERY_TOKEN", () => {
    it("opens the SSE query-token path from the branded flag without writing the ELIZA mirror", () => {
      process.env.MILADY_ALLOW_WS_QUERY_TOKEN = "1";
      const req = {
        method: "GET",
        headers: { accept: "text/event-stream" },
        url: "/api/stream?token=sse-tok",
      } as unknown as http.IncomingMessage;
      expect(extractAuthToken(req)).toBe("sse-tok");
      expect(process.env.ELIZA_ALLOW_WS_QUERY_TOKEN).toBeUndefined();
    });

    it("keeps the SSE query-token path closed when the flag is unset", () => {
      const req = {
        method: "GET",
        headers: { accept: "text/event-stream" },
        url: "/api/stream?token=sse-tok",
      } as unknown as http.IncomingMessage;
      expect(extractAuthToken(req)).toBeNull();
    });

    it("accepts a WebSocket handshake query token when the branded flag is set", () => {
      process.env.ELIZA_API_TOKEN = "ws-expected-token";
      process.env.MILADY_ALLOW_WS_QUERY_TOKEN = "1";
      const request = {
        method: "GET",
        headers: {},
      } as unknown as http.IncomingMessage;
      const url = new URL("http://localhost/ws?token=ws-expected-token");
      expect(isWebSocketAuthorized(request, url)).toBe(true);
    });

    it("lets a present canonical ELIZA_ALLOW_WS_QUERY_TOKEN=0 win over the branded flag", () => {
      process.env.ELIZA_API_TOKEN = "ws-expected-token";
      process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "0";
      process.env.MILADY_ALLOW_WS_QUERY_TOKEN = "1";
      const request = {
        method: "GET",
        headers: {},
      } as unknown as http.IncomingMessage;
      const url = new URL("http://localhost/ws?token=ws-expected-token");
      // ELIZA "0" wins → query-token path stays closed → no header token → reject.
      expect(isWebSocketAuthorized(request, url)).toBe(false);
    });
  });

  describe("resolveWalletExportRejection — ELIZA_WALLET_EXPORT_TOKEN", () => {
    it("authorizes against the branded MILADY_WALLET_EXPORT_TOKEN without writing the ELIZA mirror", () => {
      process.env.MILADY_WALLET_EXPORT_TOKEN = "milady-wallet-secret";
      expect(
        resolveWalletExportRejection(
          asReq({ "x-eliza-export-token": "milady-wallet-secret" }),
          { confirm: true },
        ),
      ).toBeNull();
      expect(
        resolveWalletExportRejection(
          asReq({ "x-eliza-export-token": "wrong" }),
          { confirm: true },
        ),
      ).toEqual({ status: 401, reason: "Invalid export token." });
      expect(process.env.ELIZA_WALLET_EXPORT_TOKEN).toBeUndefined();
    });

    it("reports export disabled when neither the branded nor canonical token is set", () => {
      const rejection = resolveWalletExportRejection(asReq(), {
        confirm: true,
      });
      expect(rejection?.status).toBe(403);
      expect(rejection?.reason).toContain("Wallet export is disabled");
    });

    it("lets a present canonical ELIZA_WALLET_EXPORT_TOKEN win over the branded alias", () => {
      process.env.ELIZA_WALLET_EXPORT_TOKEN = "canonical-wallet-secret";
      process.env.MILADY_WALLET_EXPORT_TOKEN = "brand-wallet-secret";
      expect(
        resolveWalletExportRejection(
          asReq({ "x-eliza-export-token": "canonical-wallet-secret" }),
          { confirm: true },
        ),
      ).toBeNull();
      expect(
        resolveWalletExportRejection(
          asReq({ "x-eliza-export-token": "brand-wallet-secret" }),
          { confirm: true },
        ),
      ).toEqual({ status: 401, reason: "Invalid export token." });
    });
  });

  describe("resolveMcpTerminalAuthorizationRejection — ELIZA_TERMINAL_RUN_TOKEN", () => {
    const stdioServers = {
      local: { type: "stdio", command: "echo", args: [] },
    };

    it("treats the branded MILADY_TERMINAL_RUN_TOKEN as configured so the stdio gate demands a token (not 403-unconfigured)", () => {
      process.env.MILADY_TERMINAL_RUN_TOKEN = "milady-terminal-secret";
      const rejection = resolveMcpTerminalAuthorizationRejection(
        asReq(),
        stdioServers,
        {},
      );
      // expected token IS configured (via the alias) → delegates to the terminal
      // gate, which 401s on the missing header rather than 403-ing unconfigured.
      expect(rejection).toEqual({
        status: 401,
        reason:
          "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
      });
      expect(process.env.ELIZA_TERMINAL_RUN_TOKEN).toBeUndefined();
    });

    it("rejects stdio MCP as unconfigured (403) when neither the branded nor canonical token is set", () => {
      const rejection = resolveMcpTerminalAuthorizationRejection(
        asReq(),
        stdioServers,
        {},
      );
      expect(rejection?.status).toBe(403);
      expect(rejection?.reason).toContain("requires ELIZA_TERMINAL_RUN_TOKEN");
    });
  });

  describe("readAliasedEnv primitive — ELIZA_API_PORT / ELIZA_CHAT_GENERATION_TIMEOUT_MS", () => {
    // server.ts (port selection + HTTP request timeout), tui/agent-terminal-tui.ts
    // (port selection), and chat-routes.ts (generation timeout) all migrated to the
    // exact `readAliasedEnv("ELIZA_API_PORT")` / `readAliasedEnv("ELIZA_CHAT_GENERATION_TIMEOUT_MS")`
    // calls exercised here; the port selection also feeds the alias-aware resolveDesktopApiPort.
    it("resolves ELIZA_API_PORT from the branded alias, honors ELIZA precedence, and writes no mirror", () => {
      process.env.MILADY_API_PORT = "45999";
      expect(readAliasedEnv("ELIZA_API_PORT")).toBe("45999");
      expect(resolveDesktopApiPort(process.env)).toBe(45999);
      expect(process.env.ELIZA_API_PORT).toBeUndefined();

      process.env.ELIZA_API_PORT = "31337";
      expect(readAliasedEnv("ELIZA_API_PORT")).toBe("31337");
      expect(resolveDesktopApiPort(process.env)).toBe(31337);
    });

    it("resolves ELIZA_CHAT_GENERATION_TIMEOUT_MS from the branded alias, honors ELIZA precedence, and writes no mirror", () => {
      process.env.MILADY_CHAT_GENERATION_TIMEOUT_MS = "123456";
      expect(readAliasedEnv("ELIZA_CHAT_GENERATION_TIMEOUT_MS")).toBe("123456");
      expect(process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS).toBeUndefined();

      process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS = "180000";
      expect(readAliasedEnv("ELIZA_CHAT_GENERATION_TIMEOUT_MS")).toBe("180000");
    });
  });
});
