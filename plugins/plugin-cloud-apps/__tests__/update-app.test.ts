/**
 * UPDATE_APP tests covering the pure parseUpdateAppIntent parser and the action. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { UpdateAppInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setListApps,
  setUpdateApp,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { updateAppAction } = await import("../src/actions/update-app.ts");
const { parseUpdateAppIntent } = await import("../src/actions/update-app.ts");
const { cloudAppsProvider } = await import("../src/providers/cloud-apps.ts");

const APP = makeApp({ id: "id-acme", name: "Acme Bot", slug: "acme-bot" });

/** Track updateApp calls; echoes the patch into the returned app. */
function trackUpdates(): {
  calls: Array<{ id: string; patch: UpdateAppInput }>;
} {
  const calls: Array<{ id: string; patch: UpdateAppInput }> = [];
  setUpdateApp((id, patch) => {
    calls.push({ id, patch });
    return Promise.resolve({
      success: true,
      app: makeApp({
        id: "id-acme",
        slug: "acme-bot",
        name: patch.name ?? "Acme Bot",
        description: patch.description ?? null,
        logo_url: patch.logo_url ?? null,
      }),
    });
  });
  return { calls };
}

describe("parseUpdateAppIntent", () => {
  it("parses a rename into a reference + name patch", () => {
    const intent = parseUpdateAppIntent("rename Acme Bot to Zephyr");
    expect(intent.reference).toBe("Acme Bot");
    expect(intent.patch.name).toBe("Zephyr");
  });

  it("parses a description set with an explicit app", () => {
    const intent = parseUpdateAppIntent(
      "set the description of Acme Bot to a friendly support bot",
    );
    expect(intent.reference).toBe("Acme Bot");
    expect(intent.patch.description).toBe("a friendly support bot");
  });

  it("prefers planner options over text", () => {
    const intent = parseUpdateAppIntent("change something", {
      appName: "Acme Bot",
      name: "Beta",
    });
    expect(intent.reference).toBe("Acme Bot");
    expect(intent.patch.name).toBe("Beta");
  });

  it("returns an empty patch when nothing is parseable", () => {
    const intent = parseUpdateAppIntent("do something to my app");
    expect(Object.keys(intent.patch)).toHaveLength(0);
  });
});

describe("UPDATE_APP", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await updateAppAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await updateAppAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("renames an app: calls updateApp with the name patch and confirms", async () => {
    const updates = trackUpdates();
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("rename Acme Bot to Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(updates.calls).toHaveLength(1);
    expect(updates.calls[0]?.id).toBe("id-acme");
    expect(updates.calls[0]?.patch).toEqual({ name: "Zephyr" });
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text).toContain("Zephyr");
    expect((result?.data as { updated: string[] }).updated).toEqual(["name"]);
  });

  it("updates a description", async () => {
    const updates = trackUpdates();
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("set the description of Acme Bot to a helpful bot"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(updates.calls[0]?.patch).toEqual({ description: "a helpful bot" });
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text?.toLowerCase()).toContain("description updated");
  });

  it("rejects a malformed logo URL before calling the API", async () => {
    const updates = trackUpdates();
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("set the logo of Acme Bot to not-a-url"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(updates.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("invalid_url");
  });

  it("asks what to change when no field is parseable", async () => {
    const updates = trackUpdates();
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("update my app"),
      undefined,
      { appName: "Acme Bot" },
      cb.fn,
    );
    expect(updates.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("no_change");
  });

  it("returns not-found for an unknown app", async () => {
    const updates = trackUpdates();
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("rename Zephyr to Gamma"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(updates.calls).toHaveLength(0);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      unkeyedRuntime(),
      makeMessage("rename Acme Bot to Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("surfaces an update API error", async () => {
    setUpdateApp(() => Promise.reject(new Error("boom")));
    const cb = captureCallback();
    const result = await updateAppAction.handler(
      keyedRuntime(),
      makeMessage("rename Acme Bot to Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });

  it("invalidates the CLOUD_APPS provider cache after a successful update", async () => {
    const runtime = keyedRuntime();
    trackUpdates();

    const primed = await cloudAppsProvider.get(
      runtime,
      makeMessage("my apps"),
      {} as never,
    );
    expect(primed.text).toContain("Acme Bot");

    const result = await updateAppAction.handler(
      runtime,
      makeMessage("rename Acme Bot to Zephyr"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    expect(result?.success).toBe(true);

    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ id: "id-acme", slug: "acme-bot", name: "Zephyr" })],
      }),
    );
    const after = await cloudAppsProvider.get(
      runtime,
      makeMessage("my apps"),
      {} as never,
    );
    expect(after.text).toContain("Zephyr");
    expect(after.text).not.toContain("Acme Bot");
  });
});
