import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeployAppFrontendInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  makeRuntime,
  resetSdk,
  setDeployAppFrontend,
  setGetApp,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { deployFrontendAction } = await import(
  "../src/actions/deploy-frontend.ts"
);

const APP = makeApp({ id: "app_1", name: "Acme Bot", slug: "acme-bot" });

let tmp: string | null = null;

describe("DEPLOY_FRONTEND", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setGetApp(() => Promise.resolve({ success: true, app: APP }));
  });
  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  describe("validate", () => {
    it("true with a key, false without", async () => {
      expect(
        await deployFrontendAction.validate(keyedRuntime(), makeMessage("x")),
      ).toBe(true);
      expect(
        await deployFrontendAction.validate(unkeyedRuntime(), makeMessage("x")),
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("reports no-key when unconfigured", async () => {
      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        unkeyedRuntime(),
        makeMessage("publish Acme Bot"),
        undefined,
        { directory: "/x" },
        cb.callback,
      );
      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "no_key" });
    });

    it("asks which app when no reference is given", async () => {
      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        keyedRuntime(),
        makeMessage(""),
        undefined,
        {},
        cb.callback,
      );
      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "no_reference" });
    });

    it("reports not-found for an unknown app", async () => {
      setListApps(() => Promise.resolve({ success: true, apps: [] }));
      setGetApp(() =>
        Promise.resolve({ success: true, app: undefined as never }),
      );
      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        keyedRuntime(),
        makeMessage("publish Nonexistent"),
        undefined,
        { directory: "/x" },
        cb.callback,
      );
      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "not_found" });
    });

    it("requires a build source (no directory, no files)", async () => {
      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        makeRuntime({
          ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
          ELIZAOS_CLOUD_FRONTEND_BUILD_ROOT: tmp,
        }),
        makeMessage("publish Acme Bot"),
        undefined,
        {},
        cb.callback,
      );
      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "no_source" });
    });

    it("publishes inline files", async () => {
      let captured: DeployAppFrontendInput | null = null;
      setDeployAppFrontend((_id, input) => {
        captured = input;
        return Promise.resolve({
          success: true,
          deployment: {
            id: "fe_1",
            app_id: "app_1",
            version: 1,
            status: "active",
            r2_prefix: "p/",
            content_hash: "b".repeat(64),
            file_count: 1,
            total_bytes: 42,
            error: null,
            created_at: "2026-06-29T00:00:00.000Z",
            activated_at: "2026-06-29T00:00:00.000Z",
          },
        });
      });
      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        keyedRuntime(),
        makeMessage("publish Acme Bot"),
        undefined,
        { files: [{ path: "index.html", content: "<html></html>" }] },
        cb.callback,
      );
      expect(res.success).toBe(true);
      expect(captured?.files).toHaveLength(1);
      expect(res.data).toMatchObject({
        deployment: { version: 1, status: "active" },
      });
    });

    it("reads a build directory and uploads its files (text + base64)", async () => {
      tmp = await fs.mkdtemp(path.join(tmpdir(), "fe-deploy-"));
      await fs.writeFile(
        path.join(tmp, "index.html"),
        "<html><body>hi</body></html>",
      );
      await fs.writeFile(path.join(tmp, ".env"), "SECRET=do-not-publish");
      await fs.mkdir(path.join(tmp, "assets"));
      await fs.writeFile(path.join(tmp, "assets", "app.js"), "console.log(1)");
      // a binary file → base64
      await fs.writeFile(
        path.join(tmp, "logo.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      let captured: DeployAppFrontendInput | null = null;
      setDeployAppFrontend((_id, input) => {
        captured = input;
        return Promise.resolve({
          success: true,
          deployment: {
            id: "fe_2",
            app_id: "app_1",
            version: 2,
            status: "active",
            r2_prefix: "p2/",
            content_hash: "c".repeat(64),
            file_count: input.files.length,
            total_bytes: 500,
            error: null,
            created_at: "2026-06-29T00:00:00.000Z",
            activated_at: "2026-06-29T00:00:00.000Z",
          },
        });
      });

      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        keyedRuntime(),
        makeMessage("publish Acme Bot"),
        undefined,
        { directory: "." },
        cb.callback,
      );
      expect(res.success).toBe(true);
      const paths = (captured?.files ?? []).map((f) => f.path).sort();
      expect(paths).toEqual(["assets/app.js", "index.html", "logo.png"]);
      expect(paths).not.toContain(".env");
      const png = captured?.files.find((f) => f.path === "logo.png");
      expect(png?.encoding).toBe("base64");
      const html = captured?.files.find((f) => f.path === "index.html");
      expect(html?.encoding).toBe("utf8");
    });

    it("rejects a build directory outside the configured frontend build root", async () => {
      tmp = await fs.mkdtemp(path.join(tmpdir(), "fe-deploy-root-"));
      const allowedRoot = path.join(tmp, "allowed");
      const outsideRoot = path.join(tmp, "outside");
      await fs.mkdir(allowedRoot);
      await fs.mkdir(outsideRoot);
      await fs.writeFile(path.join(outsideRoot, "index.html"), "<html></html>");

      let uploaded = false;
      setDeployAppFrontend(() => {
        uploaded = true;
        throw new Error("should not upload");
      });

      const cb = captureCallback();
      const res = await deployFrontendAction.handler(
        makeRuntime({
          ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
          ELIZAOS_CLOUD_FRONTEND_BUILD_ROOT: allowedRoot,
        }),
        makeMessage("publish Acme Bot"),
        undefined,
        { directory: outsideRoot },
        cb.callback,
      );

      expect(res.success).toBe(false);
      expect(res.data).toMatchObject({ reason: "read_failed" });
      expect(res.userFacingText).toContain("configured frontend build root");
      expect(uploaded).toBe(false);
    });
  });
});
