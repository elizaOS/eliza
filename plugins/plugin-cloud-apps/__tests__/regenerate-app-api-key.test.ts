/**
 * REGENERATE_APP_API_KEY action tests: key rotation and the one-time reveal of the new key. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setListApps,
  setRegenerateAppApiKey,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { regenerateAppApiKeyAction } = await import(
  "../src/actions/regenerate-app-api-key.ts"
);

const APP = makeApp({ id: "id-acme", name: "Acme Bot", slug: "acme-bot" });
const NEW_KEY = "eliza_app_rotated_secret_value";

/** Track rotate calls; returns the new key once. */
function trackRotations(): { count: () => number } {
  let count = 0;
  setRegenerateAppApiKey(() => {
    count += 1;
    return Promise.resolve({ success: true, apiKey: NEW_KEY });
  });
  return { count: () => count };
}

describe("REGENERATE_APP_API_KEY", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await regenerateAppApiKeyAction.validate(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await regenerateAppApiKeyAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("first ask: confirms and does NOT rotate", async () => {
    const rotations = trackRotations();
    const cb = captureCallback();
    const result = await regenerateAppApiKeyAction.handler(
      keyedRuntime(),
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(rotations.count()).toBe(0);
    expect((result?.data as { rotated: boolean }).rotated).toBe(false);
    expect(
      (result?.data as { confirmationRequired: boolean }).confirmationRequired,
    ).toBe(true);
    const prompt = cb.calls[0]?.text ?? "";
    expect(prompt).toContain("Acme Bot");
    expect(prompt.toLowerCase()).toContain("immediately");
    // The new key must NOT leak in the confirmation prompt.
    expect(prompt).not.toContain(NEW_KEY);
  });

  it("explicit confirmation: rotates once and shows the new key exactly once", async () => {
    const rotations = trackRotations();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("confirmo"),
      undefined,
      { confirm: true },
      cb.fn,
    );

    expect(rotations.count()).toBe(1);
    expect(result?.success).toBe(true);
    expect((result?.data as { rotated: boolean }).rotated).toBe(true);

    // The key is shown ONCE in the user-facing reply...
    const replies = cb.calls.filter((c) => (c.text ?? "").includes(NEW_KEY));
    expect(replies).toHaveLength(1);
    expect(cb.calls.at(-1)?.text?.toLowerCase()).toContain(
      "won't be shown again",
    );

    // ...but never placed in the persisted `data` or summary `text`.
    expect(JSON.stringify(result?.data)).not.toContain(NEW_KEY);
    expect(result?.text ?? "").not.toContain(NEW_KEY);
  });

  it("handles a rotate that returns no key", async () => {
    setRegenerateAppApiKey(() => Promise.resolve({ success: true }));
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key_returned");
  });

  it("structured confirm without a pending prompt does NOT rotate", async () => {
    const rotations = trackRotations();
    const result = await regenerateAppApiKeyAction.handler(
      keyedRuntime(),
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(rotations.count()).toBe(0);
    expect((result?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("structured cancellation consumes the pending prompt without rotating", async () => {
    const rotations = trackRotations();
    const runtime = keyedRuntime();
    await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("cancel"),
      undefined,
      { confirm: false },
      captureCallback().fn,
    );
    expect(rotations.count()).toBe(0);
    expect((result?.data as { canceled: boolean }).canceled).toBe(true);
  });

  it("returns not-found for an unknown app (no rotate)", async () => {
    const rotations = trackRotations();
    const result = await regenerateAppApiKeyAction.handler(
      keyedRuntime(),
      makeMessage("rotate Zephyr"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(rotations.count()).toBe(0);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const result = await regenerateAppApiKeyAction.handler(
      unkeyedRuntime(),
      makeMessage("rotate Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("confirm naming a DIFFERENT app refuses, rotates nothing, and clears the pending", async () => {
    const rotations = trackRotations();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("yes — rotate the key for Beta Dashboard"),
      undefined,
      { parameters: { confirm: true, appName: "Beta Dashboard" } },
      cb.fn,
    );

    expect(rotations.count()).toBe(0);
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );
    const reply = cb.calls.at(-1)?.text ?? "";
    expect(reply).toContain("Beta Dashboard");
    expect(reply).toContain("Acme Bot");
    expect(reply).not.toContain(NEW_KEY);

    const followUp = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(rotations.count()).toBe(0);
    expect((followUp?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("surfaces a rotate API error", async () => {
    setRegenerateAppApiKey(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("regenerate the API key for Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await regenerateAppApiKeyAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
