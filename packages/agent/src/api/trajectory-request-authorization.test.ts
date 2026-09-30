import type http from "node:http";
import { describe, expect, it } from "vitest";
import { isTrajectoryOwnerRequest } from "./trajectory-request-authorization";

describe("owner-only credential resolution", () => {
  it("does not promote a USER or invalid bearer to OWNER through loopback", () => {
    const req = {
      method: "GET",
      headers: { authorization: "Bearer invalid-token" },
      socket: { remoteAddress: "127.0.0.1" },
    } as http.IncomingMessage;
    expect(
      isTrajectoryOwnerRequest(
        req,
        "GET",
        "/api/automations",
        { ok: true, role: "USER" },
        false,
      ),
    ).toBe(false);
    expect(
      isTrajectoryOwnerRequest(
        req,
        "GET",
        "/api/automations",
        { ok: false, role: "NONE" },
        false,
      ),
    ).toBe(false);
    expect(
      isTrajectoryOwnerRequest(
        req,
        "GET",
        "/api/automations",
        { ok: true, role: "OWNER" },
        false,
      ),
    ).toBe(true);
  });
});
