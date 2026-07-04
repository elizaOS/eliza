/**
 * BACKUP_APP action tests: on-demand app backup snapshots. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setExportAppBackup,
  setGetApp,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { backupAppAction } = await import("../src/actions/backup-app.ts");

const APP = makeApp({ id: "app_1", name: "Acme Bot", slug: "acme-bot" });

describe("BACKUP_APP", () => {
  beforeEach(() => {
    resetSdk();
    setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
    setGetApp(() => Promise.resolve({ success: true, app: APP }));
  });

  it("validate: true with key, false without", async () => {
    expect(
      await backupAppAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await backupAppAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("no key → no_key", async () => {
    const cb = captureCallback();
    const res = await backupAppAction.handler(
      unkeyedRuntime(),
      makeMessage("back up Acme Bot"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "no_key" });
  });

  it("exports the snapshot and returns it in data", async () => {
    let requestedId: string | null = null;
    setExportAppBackup((appId) => {
      requestedId = appId;
      return Promise.resolve({
        success: true,
        backup: {
          version: 1,
          exportedAt: "2020-01-01T00:00:00Z",
          app: {
            name: "Acme Bot",
            description: null,
            app_url: "https://a",
            allowed_origins: [],
            logo_url: null,
            website_url: null,
            contact_email: null,
            linked_character_ids: [],
          },
          monetization: {
            enabled: true,
            inference_markup_percentage: 30,
            purchase_share_percentage: 0,
          },
        },
      });
    });
    const cb = captureCallback();
    const res = await backupAppAction.handler(
      keyedRuntime(),
      makeMessage("back up Acme Bot"),
      undefined,
      { app: "Acme Bot" },
      cb.callback,
    );
    expect(res.success).toBe(true);
    expect(requestedId).toBe("app_1");
    expect(
      (res.data as { backup?: { version?: number } }).backup?.version,
    ).toBe(1);
    expect(res.userFacingText).toContain("30%");
  });

  it("unknown app → not_found", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [] }));
    setGetApp(() =>
      Promise.resolve({ success: true, app: undefined as never }),
    );
    const cb = captureCallback();
    const res = await backupAppAction.handler(
      keyedRuntime(),
      makeMessage("back up Nope"),
      undefined,
      {},
      cb.callback,
    );
    expect(res.success).toBe(false);
    expect(res.data).toMatchObject({ reason: "not_found" });
  });
});
