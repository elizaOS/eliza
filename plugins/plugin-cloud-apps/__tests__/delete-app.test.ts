import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setDeleteApp,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { deleteAppAction } = await import("../src/actions/delete-app.ts");

const APP = makeApp({ id: "id-acme", name: "Acme Bot", slug: "acme-bot" });

/** Track delete calls; returns the call count getter. */
function trackDeletes(): { count: () => number } {
  let count = 0;
  setDeleteApp(() => {
    count += 1;
    return Promise.resolve({ success: true, message: "deleted" });
  });
  return { count: () => count };
}

describe("DELETE_APP", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await deleteAppAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await deleteAppAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("first ask: returns a confirmation prompt and does NOT delete", async () => {
    const deletes = trackDeletes();
    const cb = captureCallback();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("delete my Acme Bot app"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(deletes.count()).toBe(0);
    expect((result?.data as { deleted: boolean }).deleted).toBe(false);
    expect(
      (result?.data as { confirmationRequired: boolean }).confirmationRequired,
    ).toBe(true);
    const prompt = cb.calls[0]?.text ?? "";
    expect(prompt).toContain("Acme Bot");
    expect(prompt).toContain("tenant database");
    expect(prompt.toLowerCase()).toContain("can't be undone");
  });

  it("explicit confirmation: deletes exactly once", async () => {
    const deletes = trackDeletes();
    const cb = captureCallback();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("delete Acme Bot — yes"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(deletes.count()).toBe(1);
    expect(result?.success ?? false).toBe(true);
    expect((result?.data as { deleted: boolean }).deleted).toBe(true);
    expect(cb.calls[0]?.text).toContain("Deleted");
  });

  it("a bare 'yes' is NOT enough to delete (connector-agnostic safety)", async () => {
    const deletes = trackDeletes();
    const cb = captureCallback();
    // resolve via planner option; confirmation parsed from the text only
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("yes"),
      undefined,
      { appName: "Acme Bot" },
      cb.fn,
    );
    expect(deletes.count()).toBe(0);
    expect(
      (result?.data as { confirmationRequired: boolean }).confirmationRequired,
    ).toBe(true);
  });

  it("a hesitant follow-up does NOT delete", async () => {
    const deletes = trackDeletes();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("hmm not sure, maybe later"),
      undefined,
      { appName: "Acme Bot" },
      captureCallback().fn,
    );
    expect(deletes.count()).toBe(0);
    expect((result?.data as { deleted: boolean }).deleted).toBe(false);
  });

  it("returns not-found for an unknown app (no confirmation, no delete)", async () => {
    const deletes = trackDeletes();
    const cb = captureCallback();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("delete Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(deletes.count()).toBe(0);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const cb = captureCallback();
    const result = await deleteAppAction.handler(
      unkeyedRuntime(),
      makeMessage("delete Acme Bot — yes"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("surfaces a delete API error", async () => {
    setDeleteApp(() => Promise.reject(new Error("boom")));
    const cb = captureCallback();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("delete Acme Bot — yes"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
