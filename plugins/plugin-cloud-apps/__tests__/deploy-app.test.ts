/**
 * DEPLOY_APP action tests: the completion gate (poll to READY, then reachability-probe the production_url before claiming live). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real. The reachability probe is injected.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  type MemoryRuntime,
  makeApp,
  makeRoomMessage,
  memoryRuntime,
  resetSdk,
  setDeployApp,
  setGetApp,
  setGetAppDeployStatus,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { deployAppAction } = await import("../src/actions/deploy-app.ts");
const { APP_DEPLOY_FACT_SOURCE } = await import("../src/app-facts.ts");

const realFetch = globalThis.fetch;

/** Stub the reachability probe's global fetch. */
function stubFetch(result: { ok: boolean; status: number } | Error): void {
  globalThis.fetch = mock(() =>
    result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result as unknown as Response),
  ) as unknown as typeof fetch;
}

/** Wire the SDK so resolveApp + the gate see one deployable app. */
function wireApp(
  app = makeApp({
    id: "id-acme",
    name: "Acme Bot",
    slug: "acme-bot",
    production_url: "https://acme.elizacloud.ai",
    deployment_status: "deployed",
  }),
): void {
  setListApps(() => Promise.resolve({ success: true, apps: [app] }));
  setGetApp(() => Promise.resolve({ success: true, app }));
  setDeployApp(() =>
    Promise.resolve({
      success: true,
      deploymentId: "dep_1",
      status: "BUILDING",
      startedAt: "2026-06-29T00:00:00.000Z",
    }),
  );
}

describe("DEPLOY_APP", () => {
  beforeEach(() => {
    resetSdk();
    stubFetch({ ok: true, status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await deployAppAction.validate(keyedRuntime(), makeRoomMessage("x")),
    ).toBe(true);
    expect(
      await deployAppAction.validate(unkeyedRuntime(), makeRoomMessage("x")),
    ).toBe(false);
  });

  it("deploys, waits for READY, probes /health, and reports the live url", async () => {
    wireApp();
    setGetAppDeployStatus(() =>
      Promise.resolve({
        success: true,
        deploymentId: "dep_1",
        status: "READY",
        vercelUrl: null,
        error: null,
        startedAt: null,
      }),
    );

    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage("deploy my Acme Bot app"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(true);
    expect((result?.data as { phase: string }).phase).toBe("ready");
    expect((result?.data as { url: string }).url).toBe(
      "https://acme.elizacloud.ai",
    );
    const finalReply = cb.calls[cb.calls.length - 1]?.text ?? "";
    expect(finalReply).toContain("live at https://acme.elizacloud.ai");
  });

  it("does NOT claim live when /health is unreachable", async () => {
    wireApp();
    setGetAppDeployStatus(() =>
      Promise.resolve({
        success: true,
        deploymentId: "dep_1",
        status: "READY",
        vercelUrl: null,
        error: null,
        startedAt: null,
      }),
    );
    stubFetch({ ok: false, status: 503 });

    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage("ship Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect((result?.data as { phase: string }).phase).toBe("unreachable");
    const reply = cb.calls[cb.calls.length - 1]?.text ?? "";
    expect(reply.toLowerCase()).not.toContain("is live at");
    expect(reply.toLowerCase()).toContain("isn't answering");
  });

  it("surfaces a failed deploy as an error (not live)", async () => {
    wireApp();
    setGetAppDeployStatus(() =>
      Promise.resolve({
        success: true,
        deploymentId: "dep_1",
        status: "ERROR",
        vercelUrl: null,
        error: "image build failed",
        startedAt: null,
      }),
    );

    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage("deploy Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect((result?.data as { phase: string }).phase).toBe("error");
    expect(cb.calls[cb.calls.length - 1]?.text).toContain("failed");
  });

  it("returns a graceful not-found when the app does not exist", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Other", slug: "other" })],
      }),
    );
    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage("deploy Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("not_found");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const cb = captureCallback();
    const result = await deployAppAction.handler(
      unkeyedRuntime(),
      makeRoomMessage("deploy Acme"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  describe("facts cache (idempotent)", () => {
    it("writes exactly one deploy fact, and re-deploy updates it in place", async () => {
      wireApp();
      setGetAppDeployStatus(() =>
        Promise.resolve({
          success: true,
          deploymentId: "dep_1",
          status: "READY",
          vercelUrl: null,
          error: null,
          startedAt: null,
        }),
      );

      const runtime: MemoryRuntime = memoryRuntime();
      const msg = makeRoomMessage("deploy my Acme Bot app");

      const first = await deployAppAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        captureCallback().fn,
      );
      expect((first?.data as { factWritten: boolean }).factWritten).toBe(true);
      expect((first?.data as { factUpdated: boolean }).factUpdated).toBe(false);
      expect(runtime.__facts).toHaveLength(1);
      expect(runtime.__facts[0]?.content.text).toContain("Acme Bot");
      expect(runtime.__facts[0]?.content.text).toContain(
        "https://acme.elizacloud.ai",
      );
      expect((runtime.__facts[0]?.metadata as { source?: string }).source).toBe(
        APP_DEPLOY_FACT_SOURCE,
      );
      expect((runtime.__facts[0]?.metadata as { appId?: string }).appId).toBe(
        "id-acme",
      );

      const second = await deployAppAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        captureCallback().fn,
      );
      expect((second?.data as { factUpdated: boolean }).factUpdated).toBe(true);
      // Still exactly one fact — no duplicate for the same app.id.
      expect(runtime.__facts).toHaveLength(1);
    });
  });
});
