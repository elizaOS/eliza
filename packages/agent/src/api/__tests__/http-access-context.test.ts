/**
 * Unit coverage for resolveHttpAccessContext — boundary principal → core
 * AccessContext mapping, UUID normalization, and the undefined owner path.
 */
import { describe, expect, it, vi } from "vitest";
import type http from "node:http";

vi.mock("@elizaos/core", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    validateUuid: (v: string) => (UUID_RE.test(v) ? v : null),
    stringToUuid: (s: string) => {
      // Deterministic fake uuid from a string (hash → hex groups)
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      const hex = h.toString(16).padStart(8, "0");
      return `${hex}-0000-4000-8000-${hex.padEnd(12, "0")}`;
    },
  };
});
vi.mock("./boundary-role-resolver.ts", () => ({
  resolveRegisteredTokenRoleAccess: vi.fn(),
}));

import { resolveHttpAccessContext } from "./http-access-context.ts";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";

const mockResolve = vi.mocked(resolveRegisteredTokenRoleAccess);
const req = {} as http.IncomingMessage;

describe("resolveHttpAccessContext", () => {
  it("returns undefined when no resolver recognizes the request", () => {
    mockResolve.mockReturnValue(null);
    expect(resolveHttpAccessContext(req)).toBeUndefined();
  });

  it("maps an OWNER principal with requester entity id and isOwner", () => {
    const ownerUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    mockResolve.mockReturnValue({
      providerId: "waifu-chat",
      worldRole: "OWNER",
      principal: ownerUuid,
      isAdmin: true,
      isRouteInScope: () => true,
      claims: {},
    } as never);
    const ctx = resolveHttpAccessContext(req);
    expect(ctx?.role).toBe("OWNER");
    expect(ctx?.isOwner).toBe(true);
    expect(ctx?.source).toBe("waifu-chat");
    expect(ctx?.requesterEntityId).toBe(ownerUuid);
  });

  it("maps a non-UUID principal (wallet address) to a deterministic UUID", () => {
    mockResolve.mockReturnValue({
      providerId: "wallet",
      worldRole: "USER",
      principal: "0xabc123def456",
      isAdmin: false,
      isRouteInScope: () => true,
      claims: {},
    } as never);
    const ctx = resolveHttpAccessContext(req);
    expect(ctx?.role).toBe("USER");
    expect(ctx?.isOwner).toBe(false);
    // Deterministic: same input → same uuid, and it matches the uuid shape
    const again = resolveHttpAccessContext(req);
    expect(ctx?.requesterEntityId).toBe(again?.requesterEntityId);
    expect(ctx?.requesterEntityId).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it("maps a UUID principal directly without namespace transform", () => {
    const uuid = "12345678-1234-4234-8234-123456789abc";
    mockResolve.mockReturnValue({
      providerId: "artifact-share",
      worldRole: "GUEST",
      principal: uuid,
      isAdmin: false,
      isRouteInScope: () => true,
      claims: {},
    } as never);
    const ctx = resolveHttpAccessContext(req);
    expect(ctx?.requesterEntityId).toBe(uuid);
  });
});
