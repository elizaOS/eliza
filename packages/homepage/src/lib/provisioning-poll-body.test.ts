import { describe, expect, it } from "vitest";
import { buildProvisioningPollBody } from "./provisioning-poll-body.js";

describe("buildProvisioningPollBody", () => {
  it("returns web platform without session", () => {
    expect(buildProvisioningPollBody()).toEqual({
      platform: "web",
      statusOnly: true,
      sessionId: undefined,
    });
    expect(buildProvisioningPollBody(null)).toEqual({
      platform: "web",
      statusOnly: true,
      sessionId: undefined,
    });
    expect(buildProvisioningPollBody(undefined)).toEqual({
      platform: "web",
      statusOnly: true,
      sessionId: undefined,
    });
  });

  it("returns blooio platform with session", () => {
    expect(buildProvisioningPollBody("sess-123")).toEqual({
      platform: "blooio",
      statusOnly: true,
      sessionId: "sess-123",
    });
  });

  it("handles empty string as present session", () => {
    const body = buildProvisioningPollBody("");
    expect(body.sessionId).toBe("");
    expect(body.platform).toBe("web");
  });
});
