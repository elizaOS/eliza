/**
 * LIST_CLOUD_APPS action tests: the user's app inventory (name / url / status). The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  requireDefined,
  resetSdk,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

// Mock ONLY the SDK client; the action under test runs for real.
mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { listCloudAppsAction } = await import(
  "../src/actions/list-cloud-apps.ts"
);
const { cloudAppsPlugin } = await import("../src/index.ts");

describe("LIST_CLOUD_APPS", () => {
  beforeEach(() => {
    resetSdk();
  });

  describe("validate", () => {
    it("returns true when a Cloud API key is present", async () => {
      expect(
        await listCloudAppsAction.validate(keyedRuntime(), makeMessage("x")),
      ).toBe(true);
    });

    // #17363: gating this read on the key made the canonical no-key reply
    // unreachable — catalog construction and the executor both drop an action
    // whose validate() is false, so the handler never ran and the user got the
    // local installed-app answer or a generic refusal instead of the truthful
    // "no Cloud API key is configured". The action stays reachable and the
    // handler owns the capability failure.
    it("stays reachable with no Cloud API key so the handler owns the failure (#17363)", async () => {
      expect(
        await listCloudAppsAction.validate(unkeyedRuntime(), makeMessage("x")),
      ).toBe(true);
    });

    it("survives the public validate() gate that builds the action surface (#17363)", async () => {
      const runtime = unkeyedRuntime();
      const message = makeMessage("list my cloud apps");
      // The same filter the runtime applies when constructing the catalog.
      const reachable: string[] = [];
      for (const action of cloudAppsPlugin.actions ?? []) {
        if (await action.validate(runtime, message))
          reachable.push(action.name);
      }
      expect(reachable).toContain("LIST_CLOUD_APPS");
    });

    it("delivers exactly one canonical no-key reply once past that gate (#17363)", async () => {
      const runtime = unkeyedRuntime();
      const message = makeMessage("list my cloud apps");
      const action = requireDefined(
        (cloudAppsPlugin.actions ?? []).find(
          (candidate) => candidate.name === "LIST_CLOUD_APPS",
        ),
        "LIST_CLOUD_APPS registration",
      );
      expect(await action.validate(runtime, message)).toBe(true);

      const cb = captureCallback();
      const result = await action.handler(
        runtime,
        message,
        undefined,
        undefined,
        cb.fn,
      );
      expect(cb.calls).toHaveLength(1);
      expect(cb.calls[0]?.text).toContain("no Cloud API key");
      expect(result?.success).toBe(false);
      expect(result?.userFacingText).toBe(cb.calls[0]?.text ?? "");
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
    });
  });

  describe("handler", () => {
    it("lists several apps with names and urls", async () => {
      setListApps(() =>
        Promise.resolve({
          success: true,
          apps: [
            makeApp({
              id: "id-1",
              name: "Acme Bot",
              slug: "acme-bot",
              production_url: "https://acme.elizacloud.ai",
              deployment_status: "deployed",
            }),
            makeApp({
              id: "id-2",
              name: "Side Project",
              slug: "side-project",
              app_url: "https://side.example.com",
              deployment_status: "draft",
            }),
          ],
        }),
      );

      const cb = captureCallback();
      const result = await listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("what apps do I have?"),
        undefined,
        undefined,
        cb.fn,
      );

      expect(result?.success).toBe(true);
      const reply = cb.calls[0]?.text ?? "";
      expect(reply).toContain("You have 2 apps");
      expect(reply).toContain("Acme Bot");
      expect(reply).toContain("https://acme.elizacloud.ai");
      expect(reply).toContain("Side Project");
      expect(reply).toContain("https://side.example.com");
      expect(reply).toContain("deployed");
      // userFacingText mirrors the reply for the planner terminal fallback.
      expect(result?.userFacingText).toBe(reply);
      // The success list is a complete single-operation answer: verified +
      // turnComplete opt into the gated evaluator skip, so the planner never
      // re-renders the already-delivered list as a second message.
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
      expect(
        (requireDefined(result, "action result").data as { count: number })
          .count,
      ).toBe(2);
    });

    it("prefers production_url over app_url when both exist", async () => {
      setListApps(() =>
        Promise.resolve({
          success: true,
          apps: [
            makeApp({
              name: "Dual",
              app_url: "https://staging.example.com",
              production_url: "https://prod.example.com",
            }),
          ],
        }),
      );
      const cb = captureCallback();
      await listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("my apps"),
        undefined,
        undefined,
        cb.fn,
      );
      const reply = cb.calls[0]?.text ?? "";
      expect(reply).toContain("https://prod.example.com");
      expect(reply).not.toContain("staging.example.com");
    });

    it("returns a friendly message when the user has no apps", async () => {
      setListApps(() => Promise.resolve({ success: true, apps: [] }));

      const cb = captureCallback();
      const result = await listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("list my cloud apps"),
        undefined,
        undefined,
        cb.fn,
      );

      expect(result?.success).toBe(true);
      expect(
        (requireDefined(result, "action result").data as { count: number })
          .count,
      ).toBe(0);
      expect(cb.calls[0]?.text).toContain("haven't created any apps");
      // The verified empty inventory IS the complete answer: the terminal
      // stamp keeps the evaluator from paraphrasing it into a second reply
      // (#17363).
      expect(result?.userFacingText).toBe(cb.calls[0]?.text ?? "");
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
    });

    it("delivers exactly one canonical reply without a callback (userFacingText carries it)", async () => {
      setListApps(() => Promise.resolve({ success: true, apps: [] }));
      const result = await listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("list my cloud apps"),
        undefined,
        undefined,
        undefined,
      );
      expect(result?.success).toBe(true);
      expect(result?.userFacingText).toContain("haven't created any apps");
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
    });

    it("degrades gracefully when no Cloud API key is configured", async () => {
      const cb = captureCallback();
      const result = await listCloudAppsAction.handler(
        unkeyedRuntime(),
        makeMessage("what apps do I have?"),
        undefined,
        undefined,
        cb.fn,
      );

      expect(result?.success).toBe(false);
      expect(
        (requireDefined(result, "action result").data as { reason: string })
          .reason,
      ).toBe("no_key");
      expect(cb.calls[0]?.text).toContain("no Cloud API key");
      // Verified terminal FAILURE: one canonical reply, success stays false,
      // and the core failure gate may end the turn (#17363).
      expect(result?.userFacingText).toBe(cb.calls[0]?.text ?? "");
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
    });

    it("handles a Cloud API error without throwing", async () => {
      setListApps(() => Promise.reject(new Error("boom")));

      const cb = captureCallback();
      const result = await listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("my apps"),
        undefined,
        undefined,
        cb.fn,
      );

      expect(result?.success).toBe(false);
      expect(
        (requireDefined(result, "action result").data as { reason: string })
          .reason,
      ).toBe("error");
      expect(cb.calls[0]?.text).toContain("couldn't fetch");
      expect(result?.userFacingText).toBe(cb.calls[0]?.text ?? "");
      expect(result?.verifiedUserFacing).toBe(true);
      expect(result?.turnComplete).toBe(true);
    });

    it("claims only cloud-qualified aliases, leaving generic installed-app language to APP (#17363)", () => {
      const similes = listCloudAppsAction.similes ?? [];
      expect(similes.length).toBeGreaterThan(0);
      for (const simile of similes) {
        expect(simile).toMatch(/CLOUD|DEPLOYED|HOSTED/);
      }
    });

    it("does not translate a callback failure into an API error", async () => {
      setListApps(() =>
        Promise.resolve({
          success: true,
          apps: [makeApp({ name: "Delivered Once" })],
        }),
      );
      const delivered: string[] = [];
      const deliveryError = new Error("transport unavailable");

      const result = listCloudAppsAction.handler(
        keyedRuntime(),
        makeMessage("list my cloud apps"),
        undefined,
        undefined,
        async ({ text }) => {
          delivered.push(text);
          throw deliveryError;
        },
      );

      await expect(result).rejects.toBe(deliveryError);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("Delivered Once");
      expect(delivered[0]).not.toContain("Cloud API returned an error");
    });
  });
});
