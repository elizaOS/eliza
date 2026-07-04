/**
 * DELETE_APP action tests: the destructive two-phase confirm, the frozen-target guard, and honest partial-failure reporting. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
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
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("confirmar"),
      undefined,
      { confirm: true },
      cb.fn,
    );

    expect(deletes.count()).toBe(1);
    expect(result?.success ?? false).toBe(true);
    expect((result?.data as { deleted: boolean }).deleted).toBe(true);
    expect(cb.calls.at(-1)?.text).toContain("Deleted");
  });

  it("partial-cleanup failure: reports partial, does NOT claim the container/DB are gone", async () => {
    // The DELETE route returns HTTP 200 with { success:false, errors } when
    // cleanup partially fails (continueOnError) — the SDK returns it normally.
    setDeleteApp(() =>
      Promise.resolve({
        success: false,
        message: "partial cleanup",
        errors: ["tenant_db teardown failed"],
      }),
    );
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(result?.success ?? true).toBe(false);
    expect((result?.data as { partial?: boolean }).partial).toBe(true);
    expect((result?.data as { errors?: string[] }).errors).toContain(
      "tenant_db teardown failed",
    );
    const reply = cb.calls.at(-1)?.text ?? "";
    expect(reply).not.toContain("are gone");
    expect(reply.toLowerCase()).toContain("dashboard");
  });

  it("a bare 'yes' is NOT enough to delete (connector-agnostic safety)", async () => {
    const deletes = trackDeletes();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("yes"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(deletes.count()).toBe(0);
    expect(
      (result?.data as { confirmationRequired: boolean }).confirmationRequired,
    ).toBe(true);
  });

  it("a hesitant follow-up does NOT delete", async () => {
    const deletes = trackDeletes();
    const runtime = keyedRuntime();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("hmm not sure, maybe later"),
      undefined,
      { confirm: false },
      captureCallback().fn,
    );
    expect(deletes.count()).toBe(0);
    expect((result?.data as { canceled: boolean }).canceled).toBe(true);
  });

  it("structured confirm without a pending prompt does NOT delete", async () => {
    const deletes = trackDeletes();
    const result = await deleteAppAction.handler(
      keyedRuntime(),
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().fn,
    );
    expect(deletes.count()).toBe(0);
    expect((result?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
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
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("confirm naming a DIFFERENT app refuses, deletes nothing, and clears the pending", async () => {
    const deletes = trackDeletes();
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    // Real planner path: params nested under options.parameters.
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("actually — yes, delete Beta Dashboard"),
      undefined,
      { parameters: { confirm: true, appName: "Beta Dashboard" } },
      cb.fn,
    );

    expect(deletes.count()).toBe(0);
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "confirm_target_mismatch",
    );
    const reply = cb.calls.at(-1)?.text ?? "";
    expect(reply).toContain("Beta Dashboard");
    expect(reply).toContain("Acme Bot");

    // The stale pending is cleared: a follow-up bare confirm cannot delete the
    // frozen target either.
    const followUp = await deleteAppAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(deletes.count()).toBe(0);
    expect((followUp?.data as { reason: string }).reason).toBe(
      "no_pending_confirmation",
    );
  });

  it("confirm re-naming the SAME app (partial name / generic filler) still deletes", async () => {
    const deletes = trackDeletes();
    const runtime = keyedRuntime();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("yes delete acme"),
      undefined,
      { parameters: { confirm: true, appName: "acme" } },
      captureCallback().fn,
    );
    expect(deletes.count()).toBe(1);
    expect((result?.data as { deleted: boolean }).deleted).toBe(true);

    // Generic filler ("my app") is not a target switch either.
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      captureCallback().fn,
    );
    const generic = await deleteAppAction.handler(
      runtime,
      makeMessage("yes delete my app"),
      undefined,
      { parameters: { confirm: true, appName: "my app" } },
      captureCallback().fn,
    );
    expect(deletes.count()).toBe(2);
    expect((generic?.data as { deleted: boolean }).deleted).toBe(true);
  });

  it("surfaces a delete API error", async () => {
    setDeleteApp(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    const cb = captureCallback();
    await deleteAppAction.handler(
      runtime,
      makeMessage("delete Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );
    const result = await deleteAppAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
