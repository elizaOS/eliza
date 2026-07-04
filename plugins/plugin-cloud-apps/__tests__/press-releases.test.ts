/**
 * Press-release action tests (DRAFT_PRESS_RELEASE and related growth actions). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  CreatePressReleaseInput,
  PressReleaseDto,
  SubmitPressReleaseInput,
} from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeMessage,
  resetSdk,
  setCreatePressRelease,
  setListPressReleases,
  setSubmitPressRelease,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const {
  draftPressReleaseAction,
  listPressReleasesAction,
  submitPressReleaseAction,
} = await import("../src/actions/press-releases.ts");

function release(id: string, title: string): PressReleaseDto {
  return {
    id,
    organization_id: "org",
    created_by_user_id: "user",
    title,
    summary: null,
    body: "Press release body",
    boilerplate: null,
    status: "draft",
    target_audience: {},
    target_regions: [],
    assets: [],
    embargo_at: null,
    submitted_at: null,
    distributed_at: null,
    failed_reason: null,
    idempotency_key: null,
    metadata: {},
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
  };
}

function providerNotConfiguredError(): Error & {
  statusCode: number;
  errorBody: { success: false; error: string; code: string };
} {
  const error = new Error(
    "Press distribution provider is not configured",
  ) as Error & {
    statusCode: number;
    errorBody: { success: false; error: string; code: string };
  };
  error.statusCode = 503;
  error.errorBody = {
    success: false,
    error: "Press distribution provider is not configured",
    code: "PR_PROVIDER_NOT_CONFIGURED",
  };
  return error;
}

describe("DRAFT_PRESS_RELEASE", () => {
  beforeEach(() => resetSdk());

  it("validate: true with key, false without", async () => {
    expect(
      await draftPressReleaseAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await draftPressReleaseAction.validate(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("no key → no_key", async () => {
    const res = await draftPressReleaseAction.handler(
      unkeyedRuntime(),
      makeMessage("draft a press release"),
      undefined,
      { title: "Launch", body: "Body" },
      captureCallback().callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
  });

  it("creates a draft with structured title/body and target regions", async () => {
    let captured: CreatePressReleaseInput | null = null;
    setCreatePressRelease((input) => {
      captured = input;
      return Promise.resolve({
        success: true,
        release: release("pr_1", input.title),
      });
    });

    const res = await draftPressReleaseAction.handler(
      keyedRuntime(),
      makeMessage("draft a launch release"),
      undefined,
      {
        title: "Launch",
        body: "We launched.",
        summary: "Launch summary",
        targetRegions: ["US", "EU"],
      },
      captureCallback().callback,
    );
    expect(res.success).toBe(true);
    expect(captured).toMatchObject({
      title: "Launch",
      body: "We launched.",
      summary: "Launch summary",
      targetRegions: ["US", "EU"],
    });
  });
});

describe("LIST_PRESS_RELEASES", () => {
  beforeEach(() => resetSdk());

  it("lists releases with status", async () => {
    setListPressReleases(() =>
      Promise.resolve({
        success: true,
        releases: [release("pr_1", "Launch")],
      }),
    );

    const res = await listPressReleasesAction.handler(
      keyedRuntime(),
      makeMessage("show my press releases"),
      undefined,
      {},
      captureCallback().callback,
    );
    expect(res.success).toBe(true);
    expect(res.userFacingText).toContain("Launch");
    expect(res.userFacingText).toContain("draft");
  });
});

describe("SUBMIT_PRESS_RELEASE", () => {
  beforeEach(() => resetSdk());

  it("first ask requires confirmation and does not call submit", async () => {
    const runtime = keyedRuntime();
    let submitCalls = 0;
    setListPressReleases(() =>
      Promise.resolve({
        success: true,
        releases: [release("pr_1", "Launch")],
      }),
    );
    setSubmitPressRelease(() => {
      submitCalls += 1;
      return Promise.resolve({ success: true });
    });

    const res = await submitPressReleaseAction.handler(
      runtime,
      makeMessage("submit Launch"),
      undefined,
      { title: "Launch" },
      captureCallback().callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ confirmationRequired: true });
    expect(submitCalls).toBe(0);
  });

  it("explicit confirm calls submit once and reports provider-not-configured honestly", async () => {
    const runtime = keyedRuntime();
    const calls: { releaseId: string; input?: SubmitPressReleaseInput }[] = [];
    setListPressReleases(() =>
      Promise.resolve({
        success: true,
        releases: [release("pr_1", "Launch")],
      }),
    );
    setSubmitPressRelease((releaseId, input) => {
      calls.push({ releaseId, input });
      return Promise.reject(providerNotConfiguredError());
    });

    await submitPressReleaseAction.handler(
      runtime,
      makeMessage("submit Launch"),
      undefined,
      { title: "Launch" },
      captureCallback().callback,
    );
    const confirmed = await submitPressReleaseAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().callback,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ releaseId: "pr_1" });
    expect(calls[0].input?.idempotencyKey).toMatch(/^press-release-submit-/);
    expect(confirmed.success).toBe(false);
    expect(confirmed.data).toMatchObject({
      reason: "provider_not_configured",
      submitted: false,
    });

    const followUp = await submitPressReleaseAction.handler(
      runtime,
      makeMessage("confirm"),
      undefined,
      { confirm: true },
      captureCallback().callback,
    );
    expect(followUp.data).toMatchObject({ reason: "no_pending_confirmation" });
  });

  it("confirm naming a different release refuses and does not submit", async () => {
    const runtime = keyedRuntime();
    let submitCalls = 0;
    setListPressReleases(() =>
      Promise.resolve({
        success: true,
        releases: [release("pr_1", "Launch"), release("pr_2", "Other")],
      }),
    );
    setSubmitPressRelease(() => {
      submitCalls += 1;
      return Promise.resolve({ success: true });
    });

    await submitPressReleaseAction.handler(
      runtime,
      makeMessage("submit Launch"),
      undefined,
      { title: "Launch" },
      captureCallback().callback,
    );
    const res = await submitPressReleaseAction.handler(
      runtime,
      makeMessage("confirm Other"),
      undefined,
      { parameters: { confirm: true, title: "Other" } },
      captureCallback().callback,
    );

    expect(submitCalls).toBe(0);
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "confirm_target_mismatch" });
  });
});
