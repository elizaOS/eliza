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
vi.mock("./server-wallet-trade", () => compat);

import {
  resolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
} from "./server-security.ts";

describe("server-security wrappers", () => {
  it("forwards MCP terminal authorization rejection through compat context", () => {
    const req = { headers: {} } as never;
    upstreamFns.resolveMcpTerminalAuthorizationRejection.mockReturnValue("rej");
    const out = resolveMcpTerminalAuthorizationRejection(req);
    expect(
      upstreamFns.resolveMcpTerminalAuthorizationRejection,
    ).toHaveBeenCalledWith(req);
    expect(compat.runWithCompatAuthContext).toHaveBeenCalled();
    expect(compat.normalizeCompatRejection).toHaveBeenCalledWith("rej");
    expect(out).toBe("rej");
  });

  it("forwards terminal run rejection", () => {
    upstreamFns.resolveTerminalRunRejection.mockReturnValue("run-rej");
    expect(resolveTerminalRunRejection({} as never)).toBe("run-rej");
  });

  it("forwards websocket upgrade rejection", () => {
    upstreamFns.resolveWebSocketUpgradeRejection.mockReturnValue("ws-rej");
    expect(resolveWebSocketUpgradeRejection({} as never)).toBe("ws-rej");
  });

  it("forwards terminal run client id", () => {
    upstreamFns.resolveTerminalRunClientId.mockReturnValue("client-1");
    expect(resolveTerminalRunClientId({} as never)).toBe("client-1");
  });
});
