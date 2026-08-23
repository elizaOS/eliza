import { describe, expect, it, vi } from "vitest";

const upstreamFns = vi.hoisted(() => ({
  resolveMcpTerminalAuthorizationRejection: vi.fn(),
  resolveTerminalRunRejection: vi.fn(),
  resolveWebSocketUpgradeRejection: vi.fn(),
  resolveTerminalRunClientId: vi.fn(),
  ensureApiTokenForBindHost: vi.fn(),
}));

const compat = vi.hoisted(() => ({
  normalizeCompatRejection: vi.fn((v: unknown) => v),
  runWithCompatAuthContext: vi.fn((_req: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@elizaos/agent", () => upstreamFns);
vi.mock("../server-wallet-trade", () => compat);

import {
  resolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
} from "../server-security.ts";

describe("server-security wrappers", () => {
  it("forwards MCP terminal authorization rejection through compat context", () => {
    const req = { headers: {} } as never;
    const servers = { local: { type: "stdio" } };
    const body = { terminalToken: "token" };
    upstreamFns.resolveMcpTerminalAuthorizationRejection.mockReturnValue("rej");
    const out = resolveMcpTerminalAuthorizationRejection(req, servers, body);
    expect(
      upstreamFns.resolveMcpTerminalAuthorizationRejection,
    ).toHaveBeenCalledWith(req, servers, body);
    expect(compat.runWithCompatAuthContext).toHaveBeenCalled();
    expect(compat.normalizeCompatRejection).toHaveBeenCalledWith("rej");
    expect(out).toBe("rej");
  });

  it("forwards terminal run rejection", () => {
    upstreamFns.resolveTerminalRunRejection.mockReturnValue("run-rej");
    const req = {} as never;
    const body = { terminalToken: "token" };
    expect(resolveTerminalRunRejection(req, body)).toBe("run-rej");
    expect(upstreamFns.resolveTerminalRunRejection).toHaveBeenCalledWith(
      req,
      body,
    );
  });

  it("forwards websocket upgrade rejection", () => {
    upstreamFns.resolveWebSocketUpgradeRejection.mockReturnValue("ws-rej");
    const req = {} as never;
    const url = new URL("ws://localhost/ws");
    expect(resolveWebSocketUpgradeRejection(req, url)).toBe("ws-rej");
    expect(upstreamFns.resolveWebSocketUpgradeRejection).toHaveBeenCalledWith(
      req,
      url,
    );
  });

  it("forwards terminal run client id", () => {
    upstreamFns.resolveTerminalRunClientId.mockReturnValue("client-1");
    const req = {} as never;
    const body = { clientId: "client-1" };
    expect(resolveTerminalRunClientId(req, body)).toBe("client-1");
    expect(upstreamFns.resolveTerminalRunClientId).toHaveBeenCalledWith(
      req,
      body,
    );
  });
});
