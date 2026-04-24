import { afterEach, describe, expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import { executeRawSql } from "../src/lifeops/sql.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

async function installBrowserBridgeSettingsTable(
  runtimeResult: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>,
): Promise<void> {
  await executeRawSql(
    runtimeResult.runtime,
    `
      CREATE TABLE IF NOT EXISTS browser_bridge_settings (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        tracking_mode TEXT NOT NULL DEFAULT 'current_tab',
        allow_browser_control INTEGER NOT NULL DEFAULT 0,
        require_confirmation_for_account_affecting INTEGER NOT NULL DEFAULT 1,
        incognito_enabled INTEGER NOT NULL DEFAULT 0,
        site_access_mode TEXT NOT NULL DEFAULT 'current_site_only',
        granted_origins_json TEXT NOT NULL DEFAULT '[]',
        blocked_origins_json TEXT NOT NULL DEFAULT '[]',
        max_remembered_tabs INTEGER NOT NULL DEFAULT 10,
        pause_until TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  );
}

describe("LifeOps browser settings defaults", () => {
  let runtimeResult: Awaited<
    ReturnType<typeof createLifeOpsTestRuntime>
  > | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("starts with the browser bridge enabled by default", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await installBrowserBridgeSettingsTable(runtimeResult);
    const service = new LifeOpsService(runtimeResult.runtime);

    const settings = await service.getBrowserSettings();

    expect(settings.enabled).toBe(true);
    expect(settings.trackingMode).toBe("current_tab");
    expect(settings.allowBrowserControl).toBe(false);
  });
});
