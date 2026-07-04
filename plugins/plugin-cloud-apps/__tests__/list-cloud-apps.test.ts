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

    it("returns false when no Cloud API key is configured", async () => {
      expect(
        await listCloudAppsAction.validate(unkeyedRuntime(), makeMessage("x")),
      ).toBe(false);
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
      expect((result?.data as { count: number }).count).toBe(2);
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
      expect((result?.data as { count: number }).count).toBe(0);
      expect(cb.calls[0]?.text).toContain("haven't created any apps");
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
      expect((result?.data as { reason: string }).reason).toBe("no_key");
      expect(cb.calls[0]?.text).toContain("no Cloud API key");
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
      expect((result?.data as { reason: string }).reason).toBe("error");
      expect(cb.calls[0]?.text).toContain("couldn't fetch");
    });
  });
});
