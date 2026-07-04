/**
 * GET_APP_EARNINGS action tests: read-only earnings breakdown (withdrawable/pending/lifetime/withdrawn). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetAppEarnings,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { getAppEarningsAction } = await import(
  "../src/actions/get-app-earnings.ts"
);

const APP = makeApp({
  id: "id-acme",
  name: "Acme Bot",
  slug: "acme-bot",
  monetization_enabled: true,
});

function earnings(summary: Record<string, number>, enabled = true) {
  return {
    success: true,
    earnings: { summary },
    monetization: { enabled },
  };
}

describe("GET_APP_EARNINGS", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await getAppEarningsAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await getAppEarningsAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("formats the earnings balance", async () => {
    setGetAppEarnings(() =>
      Promise.resolve(
        earnings({
          withdrawableBalance: 42,
          pendingBalance: 3,
          totalLifetimeEarnings: 58,
          totalWithdrawn: 13,
          payoutThreshold: 25,
        }),
      ),
    );
    const cb = captureCallback();
    const result = await getAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("how much have I earned from Acme Bot?"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    const text = cb.calls[0]?.text ?? "";
    expect(text).toContain("$42.00");
    expect(text).toContain("$58.00");
    expect(text.toLowerCase()).toContain("withdraw now");
    expect(
      (result?.data as { withdrawableBalance: number }).withdrawableBalance,
    ).toBe(42);
  });

  it("handles empty earnings (monetized, nothing earned yet)", async () => {
    setGetAppEarnings(() =>
      Promise.resolve(
        earnings({
          withdrawableBalance: 0,
          pendingBalance: 0,
          totalLifetimeEarnings: 0,
          totalWithdrawn: 0,
          payoutThreshold: 25,
        }),
      ),
    );
    const cb = captureCallback();
    const result = await getAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("Acme Bot earnings"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text?.toLowerCase()).toContain("no earnings yet");
  });

  it("explains when monetization is off", async () => {
    const offApp = makeApp({
      id: "id-acme",
      name: "Acme Bot",
      slug: "acme-bot",
      monetization_enabled: false,
    });
    setListApps(() => Promise.resolve({ success: true, apps: [offApp] }));
    setGetAppEarnings(() => Promise.resolve({ success: true }));
    const cb = captureCallback();
    const result = await getAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("Acme Bot earnings"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text?.toLowerCase()).toContain("monetization is off");
  });

  it("returns not-found for an unknown app", async () => {
    const cb = captureCallback();
    const result = await getAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("Zephyr earnings"),
      undefined,
      undefined,
      cb.fn,
    );
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const result = await getAppEarningsAction.handler(
      unkeyedRuntime(),
      makeMessage("Acme Bot earnings"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("surfaces an earnings API error", async () => {
    setGetAppEarnings(() => Promise.reject(new Error("boom")));
    const result = await getAppEarningsAction.handler(
      keyedRuntime(),
      makeMessage("Acme Bot earnings"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
