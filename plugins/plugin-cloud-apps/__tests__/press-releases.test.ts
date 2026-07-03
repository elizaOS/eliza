import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  CreatePressReleaseInput,
  SubmitPressReleaseInput,
} from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  makePressRelease,
  resetSdk,
  setCreatePressRelease,
  setGetPressRelease,
  setListPressReleases,
  setMarkPressReleaseReady,
  setSubmitPressRelease,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const {
  createPressReleaseDraftAction,
  listPressReleasesAction,
  submitPressReleaseAction,
} = await import("../src/actions/press-releases.ts");

function cloudError(status: number, error: string, code?: string): Error {
  return Object.assign(new Error(error), {
    statusCode: status,
    errorBody: { success: false, error, ...(code ? { code } : {}) },
  });
}

describe("press release actions (#11819)", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await createPressReleaseDraftAction.validate?.(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await createPressReleaseDraftAction.validate?.(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("creates a press release draft from planner fields", async () => {
    let captured: CreatePressReleaseInput | null = null;
    setCreatePressRelease((input) => {
      captured = input;
      return Promise.resolve({
        success: true,
        release: makePressRelease({
          id: "pr_1",
          title: input.title,
          body: input.body,
          summary: input.summary ?? null,
        }),
      });
    });
    const cb = captureCallback();

    const result = await createPressReleaseDraftAction.handler?.(
      keyedRuntime(),
      makeMessage("draft a release"),
      undefined,
      {
        title: "Eliza Cloud launches PR",
        body: "Eliza Cloud now supports press releases.",
        summary: "Launch summary",
        targetRegions: ["US", "EU"],
      },
      cb.fn,
    );

    expect(result?.success).toBe(true);
    expect(captured).toMatchObject({
      title: "Eliza Cloud launches PR",
      body: "Eliza Cloud now supports press releases.",
      summary: "Launch summary",
      targetRegions: ["US", "EU"],
    });
    expect(cb.calls[0]?.text).toContain("Created press release draft");
  });

  it("lists press releases with statuses", async () => {
    setListPressReleases(() =>
      Promise.resolve({
        success: true,
        releases: [
          makePressRelease({ title: "Launch PR", status: "draft" }),
          makePressRelease({
            id: "22222222-2222-4222-8222-222222222222",
            title: "Funding PR",
            status: "ready",
          }),
        ],
      }),
    );
    const result = await listPressReleasesAction.handler?.(
      keyedRuntime(),
      makeMessage("show my press releases"),
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("Launch PR (draft");
    expect(result?.userFacingText).toContain("Funding PR (ready");
  });

  it("requires confirmation before submit and does not call the submit route", async () => {
    const release = makePressRelease({ id: "pr_1", title: "Launch PR" });
    let submitCalls = 0;
    setGetPressRelease(() => Promise.resolve({ success: true, release }));
    setSubmitPressRelease(() => {
      submitCalls += 1;
      return Promise.resolve({
        success: true,
        release: makePressRelease({ status: "submitted" }),
      });
    });

    const result = await submitPressReleaseAction.handler?.(
      keyedRuntime(),
      makeMessage("submit Launch PR"),
      undefined,
      { releaseId: "pr_1" },
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      confirmationRequired: true,
      submitted: false,
    });
    expect(submitCalls).toBe(0);
  });

  it("marks a draft ready and submits only after structured confirmation", async () => {
    const draft = makePressRelease({ id: "pr_1", title: "Launch PR" });
    const ready = makePressRelease({
      id: "pr_1",
      title: "Launch PR",
      status: "ready",
    });
    let readyCalls = 0;
    const submissions: Array<{ id: string; input: SubmitPressReleaseInput }> =
      [];
    setGetPressRelease(() =>
      Promise.resolve({ success: true, release: draft }),
    );
    setMarkPressReleaseReady((_id) => {
      readyCalls += 1;
      return Promise.resolve({ success: true, release: ready });
    });
    setSubmitPressRelease((id, input) => {
      submissions.push({ id, input });
      return Promise.resolve({
        success: true,
        release: makePressRelease({
          id,
          title: "Launch PR",
          status: "submitted",
        }),
      });
    });

    const result = await submitPressReleaseAction.handler?.(
      keyedRuntime(),
      makeMessage("confirm submit Launch PR"),
      undefined,
      { releaseId: "pr_1", confirm: true, idempotencyKey: "press-submit-1" },
    );

    expect(result?.success).toBe(true);
    expect(readyCalls).toBe(1);
    expect(submissions).toEqual([
      {
        id: "pr_1",
        input: {
          confirmPaidDistribution: true,
          idempotencyKey: "press-submit-1",
        },
      },
    ]);
  });

  it("surfaces provider-not-configured as a no-charge failure", async () => {
    const release = makePressRelease({
      id: "pr_1",
      title: "Launch PR",
      status: "ready",
    });
    setGetPressRelease(() => Promise.resolve({ success: true, release }));
    setSubmitPressRelease(() =>
      Promise.reject(
        cloudError(
          503,
          "No PR distribution provider is configured. No distribution was submitted and no charge was attempted.",
          "no_provider_configured",
        ),
      ),
    );

    const cb = captureCallback();
    const result = await submitPressReleaseAction.handler?.(
      keyedRuntime(),
      makeMessage("confirm submit Launch PR"),
      undefined,
      { releaseId: "pr_1", confirm: true },
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      reason: "no_provider_configured",
      noChargeAttempted: true,
    });
    expect(cb.calls[0]?.text).toContain("No charge was made.");
  });
});
