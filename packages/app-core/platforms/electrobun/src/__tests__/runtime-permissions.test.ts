import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrandConfig: vi.fn(() => ({ appName: "Eliza" })),
  logger: { warn: vi.fn() },
}));

vi.mock("./brand-config", () => ({ getBrandConfig: mocks.getBrandConfig }));
vi.mock("./logger", () => ({ logger: mocks.logger }));

import {
  buildRuntimePermissionUnavailableState,
  fetchRuntimePermissionState,
  isRuntimePermissionId,
  RUNTIME_PERMISSION_IDS,
} from "./runtime-permissions.ts";

describe("isRuntimePermissionId", () => {
  it("accepts only registered runtime permission ids", () => {
    for (const id of RUNTIME_PERMISSION_IDS) {
      expect(isRuntimePermissionId(id)).toBe(true);
    }
    expect(isRuntimePermissionId("camera")).toBe(false);
    expect(isRuntimePermissionId("")).toBe(false);
  });
});

describe("buildRuntimePermissionUnavailableState", () => {
  it("fails closed with denied status and no request path", () => {
    const state = buildRuntimePermissionUnavailableState("website-blocking");
    expect(state.id).toBe("website-blocking");
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.reason).toContain("unavailable");
    expect(typeof state.lastChecked).toBe("number");
  });
});

describe("fetchRuntimePermissionState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null without a port (fail-closed)", async () => {
    expect(
      await fetchRuntimePermissionState(null, "website-blocking"),
    ).toBeNull();
    expect(
      await fetchRuntimePermissionState(undefined, "website-blocking"),
    ).toBeNull();
  });

  it("uses the check path for GET", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "website-blocking",
        status: "granted",
        lastChecked: 1,
        canRequest: true,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRuntimePermissionState(
      8080,
      "website-blocking",
      "check",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/permissions/website-blocking",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result?.id).toBe("website-blocking");
  });

  it("returns null on non-ok responses", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await fetchRuntimePermissionState(8080, "website-blocking", "request"),
    ).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
