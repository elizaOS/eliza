// Exercises the setup backend's loopback authorization and plan trust boundary.
import { describe, expect, it, vi } from "vitest";
import { createFetchHandler, createServerErrorResponse } from "../../server";
import type { AdbFlasherBackend } from "../backend/adb-backend";
import type { FlashPlan, FlashRequest } from "../backend/types";

const token = "a".repeat(64);

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("setup server authorization", () => {
  it("translates backend failures at the HTTP boundary without leaking details", async () => {
    const response = createServerErrorResponse(
      new Error("sensitive native command output"),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await response.text();
    expect(body).toContain("could not complete this request");
    expect(body).not.toContain("sensitive native command output");
  });

  it("rejects requests without the per-process token", async () => {
    const handler = createFetchHandler({ authToken: token });
    const response = await handler(request("/devices"));
    expect(response.status).toBe(401);
  });

  it("executes only the exact server-held plan behind a one-use token", async () => {
    const flashRequest: FlashRequest = {
      deviceSerial: "SERIAL-1",
      buildId: "release-1",
      wipeData: false,
      dryRun: true,
    };
    const plan = {
      request: flashRequest,
      device: {},
      build: {},
      steps: [],
      artifactDir: null,
    } as unknown as FlashPlan;
    const backend = {
      createFlashPlan: vi.fn(async () => plan),
      executeFlashPlan: vi.fn(async () => undefined),
    } as unknown as AdbFlasherBackend;
    const handler = createFetchHandler({ authToken: token, backend });
    const planResponse = await handler(
      request("/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Setup-Token": token,
        },
        body: JSON.stringify(flashRequest),
      }),
    );
    const publicPlan = (await planResponse.json()) as FlashPlan;
    expect(publicPlan.executionToken).toMatch(/^[a-f0-9]{64}$/);

    const response = await handler(
      request("/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Setup-Token": token,
        },
        body: JSON.stringify({
          executionToken: publicPlan.executionToken,
          plan: { artifactDir: "/attacker-controlled" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(backend.createFlashPlan).toHaveBeenCalledWith(flashRequest);
    expect(backend.executeFlashPlan).toHaveBeenCalledWith(
      plan,
      expect.any(Function),
    );

    const replay = await handler(
      request("/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Setup-Token": token,
        },
        body: JSON.stringify({ executionToken: publicPlan.executionToken }),
      }),
    );
    expect(replay.status).toBe(409);
  });
});
