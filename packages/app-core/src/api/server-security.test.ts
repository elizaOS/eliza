/**
 * Colocated coverage for the app-core server-security wrappers. Drives the
 * real re-exported bind-host token mint and the four auth helpers through
 * live `@elizaos/agent` implementations plus the compat header mirror —
 * no mocks of the module under test.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureApiTokenForBindHost,
  resolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
} from "./server-security";

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_API_BIND",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_ALLOWED_ORIGINS",
  "CORS_ORIGINS",
  "ELIZA_ALLOWED_HOSTS",
  "WAIFU_CHAT_ACCESS_JWT_SECRET",
] as const;

const STDIO_SERVERS = {
  local: { type: "stdio", command: "echo", args: [] },
};
const HTTP_SERVERS = {
  remote: { type: "http", url: "https://example.test/mcp" },
};
const TERMINAL_SECRET = "terminal-run-secret";
const API_SECRET = "configured-api-token";

let savedEnv: Record<string, string | undefined>;

function asReq(
  headers: http.IncomingHttpHeaders = {},
  remoteAddress: string | undefined = "127.0.0.1",
): http.IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function wsUrl(pathname = "/ws", search = ""): URL {
  return new URL(`http://127.0.0.1${pathname}${search}`);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveTerminalRunClientId", () => {
  it("returns null for an empty request and empty body (empty queue)", () => {
    expect(resolveTerminalRunClientId(asReq(), {})).toBeNull();
    expect(resolveTerminalRunClientId(asReq(), null)).toBeNull();
    expect(resolveTerminalRunClientId(asReq(), undefined)).toBeNull();
  });

  it("accepts a single valid x-eliza-client-id header", () => {
    expect(
      resolveTerminalRunClientId(
        asReq({ "x-eliza-client-id": "desktop.session-1" }),
        {},
      ),
    ).toBe("desktop.session-1");
  });

  it("mirrors x-elizaos-client-id onto the upstream x-eliza-client-id header", () => {
    const req = asReq({ "x-elizaos-client-id": "app-shell" });
    expect(resolveTerminalRunClientId(req, { clientId: "body-id" })).toBe(
      "app-shell",
    );
    expect(req.headers["x-eliza-client-id"]).toBe("app-shell");
  });

  it("does not overwrite an existing x-eliza-client-id when both aliases are set (tie)", () => {
    const req = asReq({
      "x-eliza-client-id": "canonical-id",
      "x-elizaos-client-id": "brand-id",
    });
    expect(resolveTerminalRunClientId(req, { clientId: "body-id" })).toBe(
      "canonical-id",
    );
    expect(req.headers["x-eliza-client-id"]).toBe("canonical-id");
    expect(req.headers["x-elizaos-client-id"]).toBe("brand-id");
  });

  it("prefers a valid header over a valid body clientId", () => {
    expect(
      resolveTerminalRunClientId(asReq({ "x-eliza-client-id": "header-id" }), {
        clientId: "body-id",
      }),
    ).toBe("header-id");
  });

  it("falls through to body when the header is missing, blank, or invalid", () => {
    expect(resolveTerminalRunClientId(asReq(), { clientId: "from-body" })).toBe(
      "from-body",
    );
    expect(
      resolveTerminalRunClientId(asReq({ "x-eliza-client-id": "   " }), {
        clientId: "from-body",
      }),
    ).toBe("from-body");
    expect(
      resolveTerminalRunClientId(asReq({ "x-eliza-client-id": "bad id" }), {
        clientId: "from-body",
      }),
    ).toBe("from-body");
  });

  it("uses the first value of a multi-value client-id header", () => {
    expect(
      resolveTerminalRunClientId(
        asReq({ "x-eliza-client-id": ["first-id", "second-id"] }),
        { clientId: "body-id" },
      ),
    ).toBe("first-id");
  });

  it("rejects non-string body clientId and characters outside the safe alphabet", () => {
    expect(
      resolveTerminalRunClientId(asReq(), {
        clientId: 42 as unknown as string,
      }),
    ).toBeNull();
    expect(
      resolveTerminalRunClientId(asReq(), { clientId: "has/slash" }),
    ).toBeNull();
    expect(
      resolveTerminalRunClientId(asReq(), { clientId: "plus+sign" }),
    ).toBeNull();
  });

  it("accepts a 128-character id and rejects a 129-character overflow", () => {
    const atCapacity = `${"a".repeat(127)}_`;
    const overflow = `${"a".repeat(129)}`;
    expect(resolveTerminalRunClientId(asReq(), { clientId: atCapacity })).toBe(
      atCapacity,
    );
    expect(
      resolveTerminalRunClientId(asReq(), { clientId: overflow }),
    ).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(
      resolveTerminalRunClientId(
        asReq({ "x-eliza-client-id": "  trimmed.id  " }),
        {},
      ),
    ).toBe("trimmed.id");
  });
});

describe("resolveTerminalRunRejection", () => {
  it("allows the run when neither a terminal token nor an API token is configured", () => {
    expect(resolveTerminalRunRejection(asReq(), {})).toBeNull();
  });

  it("disables terminal run for token-authenticated sessions that have no terminal token", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(resolveTerminalRunRejection(asReq(), {})).toEqual({
      status: 403,
      reason:
        "Terminal run is disabled for token-authenticated API sessions. Set ELIZA_TERMINAL_RUN_TOKEN to enable command execution.",
    });
  });

  it("returns 401 when the terminal token is configured but not provided", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(resolveTerminalRunRejection(asReq(), {})).toEqual({
      status: 401,
      reason:
        "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
    });
  });

  it("accepts a matching body terminalToken", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveTerminalRunRejection(asReq(), { terminalToken: TERMINAL_SECRET }),
    ).toBeNull();
  });

  it("mirrors x-elizaos-terminal-token so the upstream header path authorizes", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    const req = asReq({ "x-elizaos-terminal-token": TERMINAL_SECRET });
    expect(resolveTerminalRunRejection(req, {})).toBeNull();
    expect(req.headers["x-eliza-terminal-token"]).toBe(TERMINAL_SECRET);
  });

  it("lets the canonical x-eliza-terminal-token win a dual-alias tie", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    const req = asReq({
      "x-eliza-terminal-token": TERMINAL_SECRET,
      "x-elizaos-terminal-token": "wrong-brand-token",
    });
    expect(resolveTerminalRunRejection(req, {})).toBeNull();
    expect(req.headers["x-eliza-terminal-token"]).toBe(TERMINAL_SECRET);
  });

  it("prefers a present header token over the body, even when the body matches", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveTerminalRunRejection(
        asReq({ "x-eliza-terminal-token": "wrong-header" }),
        { terminalToken: TERMINAL_SECRET },
      ),
    ).toEqual({ status: 401, reason: "Invalid terminal token." });
  });

  it("falls through to the body when the header is blank or a non-string array", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveTerminalRunRejection(asReq({ "x-eliza-terminal-token": "  " }), {
        terminalToken: TERMINAL_SECRET,
      }),
    ).toBeNull();
    expect(
      resolveTerminalRunRejection(
        asReq({ "x-eliza-terminal-token": [TERMINAL_SECRET] }),
        { terminalToken: TERMINAL_SECRET },
      ),
    ).toBeNull();
  });

  it("rejects a mismatched token and ignores a non-string body token", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveTerminalRunRejection(asReq(), { terminalToken: "nope" }),
    ).toEqual({ status: 401, reason: "Invalid terminal token." });
    expect(
      resolveTerminalRunRejection(asReq(), {
        terminalToken: 1 as unknown as string,
      }),
    ).toEqual({
      status: 401,
      reason:
        "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
    });
  });

  it("trims the provided header and body tokens before comparing", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveTerminalRunRejection(
        asReq({ "x-eliza-terminal-token": `  ${TERMINAL_SECRET}  ` }),
        {},
      ),
    ).toBeNull();
    expect(
      resolveTerminalRunRejection(asReq(), {
        terminalToken: `  ${TERMINAL_SECRET}  `,
      }),
    ).toBeNull();
  });
});

describe("resolveMcpTerminalAuthorizationRejection", () => {
  it("returns null when the server map is empty or has no stdio entries", () => {
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), {}, {}),
    ).toBeNull();
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), HTTP_SERVERS, {}),
    ).toBeNull();
    expect(
      resolveMcpTerminalAuthorizationRejection(
        asReq(),
        {
          missing: { url: "https://example.test" },
          array: ["stdio"],
          nothing: null,
        },
        {},
      ),
    ).toBeNull();
  });

  it("requires ELIZA_TERMINAL_RUN_TOKEN when any server is stdio", () => {
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), STDIO_SERVERS, {}),
    ).toEqual({
      status: 403,
      reason:
        "Stdio MCP server configuration requires ELIZA_TERMINAL_RUN_TOKEN. Set ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP=1 only for intentional local development.",
    });
  });

  it("detects a stdio server mixed into a larger map (single matching element)", () => {
    expect(
      resolveMcpTerminalAuthorizationRejection(
        asReq(),
        { ...HTTP_SERVERS, ...STDIO_SERVERS },
        {},
      ),
    ).toMatchObject({ status: 403 });
  });

  it("delegates to the terminal-run gate once the terminal token is configured", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_SECRET;
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), STDIO_SERVERS, {}),
    ).toEqual({
      status: 401,
      reason:
        "Missing terminal token. Provide X-Eliza-Terminal-Token header or terminalToken in request body.",
    });
    const req = asReq({ "x-elizaos-terminal-token": TERMINAL_SECRET });
    expect(
      resolveMcpTerminalAuthorizationRejection(req, STDIO_SERVERS, {}),
    ).toBeNull();
  });

  it("allows the unauthenticated-stdio compat flag to skip the unconfigured 403", () => {
    process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP = "1";
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), STDIO_SERVERS, {}),
    ).toBeNull();
  });

  it("still 403s stdio MCP under the compat flag when an API token is configured without a terminal token", () => {
    process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP = "1";
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), STDIO_SERVERS, {}),
    ).toEqual({
      status: 403,
      reason:
        "Terminal run is disabled for token-authenticated API sessions. Set ELIZA_TERMINAL_RUN_TOKEN to enable command execution.",
    });
  });

  it("does not treat a non-1 compat flag as a passthrough", () => {
    process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP = "0";
    expect(
      resolveMcpTerminalAuthorizationRejection(asReq(), STDIO_SERVERS, {}),
    ).toMatchObject({ status: 403 });
  });
});

describe("resolveWebSocketUpgradeRejection", () => {
  it("returns 404 for any pathname other than /ws, before origin or auth checks", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({
          origin: "https://evil.example",
          authorization: `Bearer ${API_SECRET}`,
        }),
        wsUrl("/ws/"),
      ),
    ).toEqual({ status: 404, reason: "Not found" });
    expect(resolveWebSocketUpgradeRejection(asReq(), wsUrl("/api/ws"))).toEqual(
      { status: 404, reason: "Not found" },
    );
  });

  it("returns 403 when a non-local origin is present and not allowlisted", () => {
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ origin: "https://evil.example" }),
        wsUrl(),
      ),
    ).toEqual({ status: 403, reason: "Origin not allowed" });
  });

  it("treats a whitespace-only Origin as not allowed", () => {
    expect(
      resolveWebSocketUpgradeRejection(asReq({ origin: "   " }), wsUrl()),
    ).toEqual({ status: 403, reason: "Origin not allowed" });
  });

  it("allows a missing origin, and a local origin only when Host matches", () => {
    expect(resolveWebSocketUpgradeRejection(asReq(), wsUrl())).toBeNull();
    // Origin is CORS-allowed, but loopback trust requires a matching Host.
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ origin: "http://localhost:5173" }),
        wsUrl(),
      ),
    ).toEqual({ status: 401, reason: "Unauthorized" });
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({
          origin: "http://localhost:5173",
          host: "localhost:5173",
        }),
        wsUrl(),
      ),
    ).toBeNull();
  });

  it("lets an allowlisted remote origin past CORS, then still requires auth", () => {
    process.env.ELIZA_ALLOWED_ORIGINS = "https://dashboard.example";
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ origin: "https://dashboard.example" }),
        wsUrl(),
      ),
    ).toEqual({ status: 401, reason: "Unauthorized" });
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({
          origin: "https://dashboard.example",
          authorization: `Bearer ${API_SECRET}`,
        }),
        wsUrl(),
      ),
    ).toBeNull();
  });

  it("allows a tokenless upgrade from a trusted loopback peer", () => {
    expect(
      resolveWebSocketUpgradeRejection(asReq({}, "127.0.0.1"), wsUrl()),
    ).toBeNull();
  });

  it("returns 401 for a tokenless upgrade from a non-loopback peer", () => {
    expect(
      resolveWebSocketUpgradeRejection(asReq({}, "8.8.8.8"), wsUrl()),
    ).toEqual({ status: 401, reason: "Unauthorized" });
  });

  it("returns 401 when local-auth is required even on loopback", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(
      resolveWebSocketUpgradeRejection(asReq({}, "127.0.0.1"), wsUrl()),
    ).toEqual({ status: 401, reason: "Unauthorized" });
  });

  it("returns 401 for a mismatched handshake bearer token", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ authorization: "Bearer wrong-token" }),
        wsUrl(),
      ),
    ).toEqual({ status: 401, reason: "Unauthorized" });
  });

  it("accepts a matching x-elizaos-token after the compat header mirror", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    const req = asReq({ "x-elizaos-token": API_SECRET });
    expect(resolveWebSocketUpgradeRejection(req, wsUrl())).toBeNull();
    expect(req.headers["x-eliza-token"]).toBe(API_SECRET);
  });

  it("accepts a matching Authorization bearer without requiring a query token", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ authorization: `Bearer ${API_SECRET}` }),
        wsUrl(),
      ),
    ).toBeNull();
  });

  it("does not reject a query token when the query-token flag is off (post-open auth)", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({}, "127.0.0.1"),
        wsUrl("/ws", `?token=${API_SECRET}`),
      ),
    ).toBeNull();
  });

  it("authorizes a query token when ELIZA_ALLOW_WS_QUERY_TOKEN=1", () => {
    process.env.ELIZA_API_TOKEN = API_SECRET;
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({}, "8.8.8.8"),
        wsUrl("/ws", `?token=${API_SECRET}`),
      ),
    ).toBeNull();
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({}, "8.8.8.8"),
        wsUrl("/ws", "?apiKey=wrong"),
      ),
    ).toEqual({ status: 401, reason: "Unauthorized" });
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({}, "8.8.8.8"),
        wsUrl("/ws", `?api_key=${API_SECRET}`),
      ),
    ).toBeNull();
  });

  it("requires a handshake token for a cloud-provisioned container", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    process.env.ELIZA_API_TOKEN = API_SECRET;
    expect(
      resolveWebSocketUpgradeRejection(asReq({}, "127.0.0.1"), wsUrl()),
    ).toEqual({ status: 401, reason: "Unauthorized" });
    expect(
      resolveWebSocketUpgradeRejection(
        asReq({ authorization: `Bearer ${API_SECRET}` }, "127.0.0.1"),
        wsUrl(),
      ),
    ).toBeNull();
  });

  it("returns 401 for a cloud-provisioned container that has no API token", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(
      resolveWebSocketUpgradeRejection(asReq({}, "127.0.0.1"), wsUrl()),
    ).toEqual({ status: 401, reason: "Unauthorized" });
  });
});

describe("ensureApiTokenForBindHost", () => {
  it("leaves an already-configured token in place on every bind", () => {
    process.env.ELIZA_API_TOKEN = "operator-supplied-token";
    ensureApiTokenForBindHost("0.0.0.0");
    ensureApiTokenForBindHost("127.0.0.1");
    expect(process.env.ELIZA_API_TOKEN).toBe("operator-supplied-token");
  });

  it("does not mint a token for a loopback bind when none is configured", () => {
    ensureApiTokenForBindHost("127.0.0.1");
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("treats an empty bind host as loopback and does not mint", () => {
    ensureApiTokenForBindHost("");
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("honors ELIZA_DISABLE_AUTO_API_TOKEN on loopback and specific non-loopback binds", () => {
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    ensureApiTokenForBindHost("127.0.0.1");
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
    ensureApiTokenForBindHost("192.168.1.5");
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("mints a 64-hex token for a wildcard bind even when auto-token is disabled", () => {
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    ensureApiTokenForBindHost("0.0.0.0");
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints a token for the IPv6 wildcard bind", () => {
    ensureApiTokenForBindHost("::");
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints a token for a specific non-loopback bind when auto-token is enabled", () => {
    ensureApiTokenForBindHost("192.168.1.5");
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints a token for a cloud-provisioned container even when auto-token is disabled", () => {
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    ensureApiTokenForBindHost("127.0.0.1");
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });
});
