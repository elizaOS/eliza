/**
 * The native (CapacitorHttp) direct-Cloud request path reports the HTTP status
 * of a failed request even when the error body is not JSON.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true },
    CapacitorHttp: { ...actual.CapacitorHttp, request: native.request },
  };
});

import { ElizaClient } from "../client-base";
import "../client-cloud";

function directCloudClient(): ElizaClient {
  return new ElizaClient(
    "https://api.eliza.app/api/v1/eliza/agents/personal:11111111-1111-5111-8111-111111111111",
    "cloud-session-token",
  );
}

afterEach(() => {
  native.request.mockReset();
});

describe("native direct Cloud request errors", () => {
  it("keeps the status of a non-JSON error page", async () => {
    native.request.mockResolvedValue({
      status: 502,
      headers: { "content-type": "text/html" },
      data: "<html><body>Bad Gateway</body></html>",
      url: "https://api.eliza.app/api/v1/billing/settings",
    });

    const error = await directCloudClient()
      .getCloudBillingSettings()
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(native.request).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({
      status: 502,
      data: "<html><body>Bad Gateway</body></html>",
    });
  });

  it("returns a JSON body on success", async () => {
    native.request.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { success: true, settings: { autoTopUp: false } },
      url: "https://api.eliza.app/api/v1/billing/settings",
    });

    await expect(
      directCloudClient().getCloudBillingSettings(),
    ).resolves.toMatchObject({ success: true });
  });
});
