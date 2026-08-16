/**
 * Proves the super-admin container inventory exposes the authoritative image
 * digest needed to construct an exact canary compare-and-swap request, and
 * that untrusted `limit` query values fail closed before any inventory query.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireAdmin = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  role: "super_admin",
}));
const getStewardAgent = mock(async () => null);
const selectedContainerFields: string[] = [];
const appliedLimits: number[] = [];
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;

const dbRead = {
  select: mock((selection: Record<string, unknown>) => {
    if ("count" in selection) {
      return {
        from: () => ({
          where: async () => [{ count: 1 }],
        }),
      };
    }

    selectedContainerFields.splice(
      0,
      selectedContainerFields.length,
      ...Object.keys(selection),
    );
    const container = {
      id: "00000000-0000-4000-8000-000000000003",
      sandboxId: "sandbox-canary",
      organizationId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000001",
      agentName: "Canary",
      status: "running",
      nodeId: "node-canary",
      containerName: "agent-canary",
      bridgePort: 21090,
      webUiPort: 23960,
      headscaleIp: "100.64.0.3",
      dockerImage: "ghcr.io/elizaos/eliza:production",
      imageDigest: SOURCE_DIGEST,
      bridgeUrl: "http://100.64.0.3:3000",
      healthUrl: "http://100.64.0.3:3000/api/health",
      lastHeartbeatAt: new Date("2026-07-23T12:00:00.000Z"),
      errorMessage: null,
      errorCount: 0,
      createdAt: new Date("2026-07-23T11:00:00.000Z"),
      updatedAt: new Date("2026-07-23T12:00:00.000Z"),
    };
    const projected = Object.fromEntries(
      Object.entries(container).filter(([field]) => field in selection),
    );
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (value: number) => {
              appliedLimits.push(value);
              return [projected];
            },
          }),
        }),
      }),
    };
  }),
};

mock.module("@/db/helpers", () => ({ dbRead }));
mock.module("@/lib/auth/workers-hono-auth", () => ({ requireAdmin }));
mock.module("@/lib/services/steward-client", () => ({ getStewardAgent }));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

describe("super-admin Docker container inventory", () => {
  beforeEach(() => {
    requireAdmin.mockClear();
    getStewardAgent.mockClear();
    dbRead.select.mockClear();
    selectedContainerFields.length = 0;
    appliedLimits.length = 0;
  });

  test("returns the persisted image digest used by canary source CAS", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(selectedContainerFields).toContain("imageDigest");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        containers: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            dockerImage: "ghcr.io/elizaos/eliza:production",
            imageDigest: SOURCE_DIGEST,
          },
        ],
        total: 1,
        returned: 1,
      },
    });
  });

  test.each([
    ["omitted", "/", 100],
    ["empty", "/?limit=", 100],
    ["one", "/?limit=1", 1],
    ["canonical", "/?limit=25", 25],
    ["max", "/?limit=500", 500],
    ["oversize clamp", "/?limit=501", 500],
  ] as const)(
    "accepts %s limit and forwards a finite page size",
    async (_label, path, expected) => {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: { filters: { limit: number } };
      };
      expect(body.success).toBe(true);
      expect(body.data.filters.limit).toBe(expected);
      expect(appliedLimits).toEqual([expected]);
      expect(dbRead.select).toHaveBeenCalled();
    },
  );

  test.each([
    ["1e9", "scientific notation that parseInt truncates to 1"],
    ["10abc", "trailing junk that parseInt accepts as 10"],
    ["0x10", "hex that parseInt(…, 10) truncates to 0"],
    ["0100", "leading zeros"],
    ["+25", "plus sign"],
    ["-5", "signed negative"],
    ["25.0", "decimal that parseInt truncates"],
    [" 25", "leading whitespace"],
    ["25 ", "trailing whitespace"],
    ["0", "zero"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    [" ", "whitespace only"],
    ["1_00", "separator"],
    ["9007199254740992", "above safe integer"],
  ] as const)("rejects %s (%s) before any inventory query", async (raw) => {
    const response = await app.request(`/?limit=${encodeURIComponent(raw)}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid limit",
      code: "validation_error",
    });
    expect(dbRead.select).not.toHaveBeenCalled();
    expect(appliedLimits).toEqual([]);
  });
});
