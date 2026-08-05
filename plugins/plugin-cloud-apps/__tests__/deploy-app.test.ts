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
  requireDefined,
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
    expect(
      (requireDefined(result, "action result").data as { phase: string }).phase,
    ).toBe("ready");
    expect(
      (requireDefined(result, "action result").data as { url: string }).url,
    ).toBe("https://acme.elizacloud.ai");
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
    expect(
      (requireDefined(result, "action result").data as { phase: string }).phase,
    ).toBe("unreachable");
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
    expect(
      (requireDefined(result, "action result").data as { phase: string }).phase,
    ).toBe("error");
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
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("not_found");
  });

  it("REGRESSION: a security-envelope reference is never echoed back to chat (tj-2dc95f75456876)", async () => {
    // With empty planner args the reference falls back to the message text.
    // The canonical accessor extracts the PAYLOAD from a stamped legacy
    // wrapped message, so the not-found reply quotes the user's actual words —
    // and never any part of the armor.
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Zenith", slug: "zenith" })],
      }),
    );
    const envelope = [
      "SECURITY NOTICE: the content below is external and untrusted.",
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
      "can u host it and give me the link pls",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    const wrappedMessage = makeRoomMessage(envelope);
    wrappedMessage.content.metadata = { externalContentWrapped: true };
    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      wrappedMessage,
      undefined,
      undefined,
      cb.fn,
    );
    const res = requireDefined(result, "action result");
    expect(res.success).toBe(false);
    expect(res.userFacingText).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(res.userFacingText).not.toContain("SECURITY NOTICE");
    expect(res.userFacingText).toContain(
      '"can u host it and give me the link pls"',
    );
    expect(cb.calls[0]?.text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    // Machine text + data reference stay clamped to a single bounded line.
    expect(requireDefined(res.text, "machine text").length).toBeLessThanOrEqual(
      160,
    );
    const data = res.data as { reason: string; reference: string };
    expect(data.reason).toBe("not_found");
    expect(data.reference.length).toBeLessThanOrEqual(121);
    expect(data.reference).not.toContain("\n");
  });

  it("REGRESSION: UNPARSEABLE armor falls back to an empty reference and the which-app ask", async () => {
    // A mangled legacy envelope (no end marker) cannot be extracted; the old
    // raw-text fallback shipped the armor into resolution and display. Now the
    // reference is empty, so the action takes its ask-the-user path and
    // resolution cannot select an app named after warning words.
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Security", slug: "security" })],
      }),
    );
    const mangled = [
      "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source (e.g., email, webhook).",
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
      "can u host it and give me the link pls",
    ].join("\n");
    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage(mangled),
      undefined,
      undefined,
      cb.fn,
    );
    const res = requireDefined(result, "action result");
    expect(res.success).toBe(false);
    expect(res.userFacingText).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(res.userFacingText).not.toContain("SECURITY NOTICE");
    expect(res.userFacingText).toContain("Which app would you like to deploy?");
    const data = res.data as { reason: string };
    expect(data.reason).toBe("no_reference");
  });

  it("not-found still quotes a short planner-supplied name", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Zenith", slug: "zenith" })],
      }),
    );
    const cb = captureCallback();
    const result = await deployAppAction.handler(
      keyedRuntime(),
      makeRoomMessage("deploy it"),
      undefined,
      { parameters: { appName: "Acme Bot" } },
      cb.fn,
    );
    const res = requireDefined(result, "action result");
    expect(res.success).toBe(false);
    expect(res.userFacingText).toContain('"Acme Bot"');
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
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("no_key");
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
      expect(
        (requireDefined(first, "first result").data as { factWritten: boolean })
          .factWritten,
      ).toBe(true);
      expect(
        (requireDefined(first, "first result").data as { factUpdated: boolean })
          .factUpdated,
      ).toBe(false);
      expect(runtime.__facts).toHaveLength(1);
      expect(runtime.__facts[0]?.content.text).toContain("Acme Bot");
      expect(runtime.__facts[0]?.content.text).toContain(
        "https://acme.elizacloud.ai",
      );
      expect(
        (
          requireDefined(runtime.__facts[0], "deploy fact").metadata as {
            source?: string;
          }
        ).source,
      ).toBe(APP_DEPLOY_FACT_SOURCE);
      expect(
        (
          requireDefined(runtime.__facts[0], "deploy fact").metadata as {
            appId?: string;
          }
        ).appId,
      ).toBe("id-acme");

      const second = await deployAppAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        captureCallback().fn,
      );
      expect(
        (
          requireDefined(second, "second result").data as {
            factUpdated: boolean;
          }
        ).factUpdated,
      ).toBe(true);
      // Still exactly one fact — no duplicate for the same app.id.
      expect(runtime.__facts).toHaveLength(1);
    });
  });
});
