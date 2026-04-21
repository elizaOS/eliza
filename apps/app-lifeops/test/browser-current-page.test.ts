import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.ts";

vi.mock("@elizaos/agent/security", () => ({
  hasAdminAccess: vi.fn(async () => true),
}));

function createRuntime(agentId: string) {
  return createLifeOpsChatTestRuntime({
    agentId,
    handleTurn: async () => ({ text: "ok" }),
    useModel: async () => {
      throw new Error("useModel should not be called in browser current-page tests");
    },
  });
}

function installBrowserSchemaBootstrap(runtime: ReturnType<typeof createRuntime>) {
  runtime.adapter.runPluginMigrations = async () => {
    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE IF NOT EXISTS life_browser_settings (
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
            CREATE TABLE IF NOT EXISTS life_browser_companions (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              browser TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              profile_label TEXT NOT NULL DEFAULT '',
              label TEXT NOT NULL DEFAULT '',
              extension_version TEXT,
              connection_state TEXT NOT NULL DEFAULT 'disconnected',
              permissions_json TEXT NOT NULL DEFAULT '{}',
              pairing_token_hash TEXT,
              pending_pairing_token_hashes_json TEXT NOT NULL DEFAULT '[]',
              last_seen_at TEXT,
              paired_at TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(agent_id, browser, profile_id)
            );
            CREATE TABLE IF NOT EXISTS life_browser_tabs (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              companion_id TEXT,
              browser TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              window_id TEXT NOT NULL,
              tab_id TEXT NOT NULL,
              url TEXT NOT NULL DEFAULT '',
              title TEXT NOT NULL DEFAULT '',
              active_in_window INTEGER NOT NULL DEFAULT 0,
              focused_window INTEGER NOT NULL DEFAULT 0,
              focused_active INTEGER NOT NULL DEFAULT 0,
              incognito INTEGER NOT NULL DEFAULT 0,
              favicon_url TEXT,
              last_seen_at TEXT NOT NULL,
              last_focused_at TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
            );
            CREATE TABLE IF NOT EXISTS life_browser_page_contexts (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              browser TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              window_id TEXT NOT NULL,
              tab_id TEXT NOT NULL,
              url TEXT NOT NULL DEFAULT '',
              title TEXT NOT NULL DEFAULT '',
              selection_text TEXT,
              main_text TEXT,
              headings_json TEXT NOT NULL DEFAULT '[]',
              links_json TEXT NOT NULL DEFAULT '[]',
              forms_json TEXT NOT NULL DEFAULT '[]',
              captured_at TEXT NOT NULL,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
            );
          `,
        },
      ],
    });
  };
}

describe("browser current-page context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the scenario wired to MANAGE_LIFEOPS_BROWSER read_current_page", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../../test/scenarios/browser.lifeops/lifeops-extension.see-what-user-sees.scenario.ts",
      ),
      "utf8",
    );

    expect(source).not.toContain("NotYetImplemented");
    expect(source).toContain("MANAGE_LIFEOPS_BROWSER");
    expect(source).toContain("read_current_page");
    expect(source).toContain("selectedAction");
    expect(source).toContain("selectedActionArguments");
    expect(source).toContain("selectionText");
  });

  it("stores the browser page context rows that read_current_page depends on", async () => {
    const runtime = createRuntime("lifeops-browser-current-page-test");
    installBrowserSchemaBootstrap(runtime);
    await runtime.adapter.runPluginMigrations?.();
    const nowIso = new Date("2026-04-20T10:00:00.000Z").toISOString();
    const agentId = "lifeops-browser-current-page-test";
    const companionId = "companion-1";
    const tabId = "tab-1";
    const windowId = "window-1";
    const url = "https://speaker-portal.example.com/submissions";

    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            INSERT INTO life_browser_settings (
              agent_id,
              enabled,
              tracking_mode,
              allow_browser_control,
              require_confirmation_for_account_affecting,
              incognito_enabled,
              site_access_mode,
              granted_origins_json,
              blocked_origins_json,
              max_remembered_tabs,
              pause_until,
              metadata_json,
              created_at,
              updated_at
            ) VALUES (
              '${agentId}',
              1,
              'current_tab',
              1,
              1,
              0,
              'current_site_only',
              '[]',
              '[]',
              10,
              NULL,
              '{}',
              '${nowIso}',
              '${nowIso}'
            );
            INSERT INTO life_browser_companions (
              id,
              agent_id,
              browser,
              profile_id,
              profile_label,
              label,
              connection_state,
              permissions_json,
              pending_pairing_token_hashes_json,
              metadata_json,
              created_at,
              updated_at
            ) VALUES (
              '${companionId}',
              '${agentId}',
              'chrome',
              'profile-1',
              'profile-1',
              'LifeOps Browser chrome profile-1',
              'connected',
              '{"tabs":true,"scripting":true,"activeTab":true,"allOrigins":true,"grantedOrigins":["https://speaker-portal.example.com"],"incognitoEnabled":false}',
              '[]',
              '{}',
              '${nowIso}',
              '${nowIso}'
            );
            INSERT INTO life_browser_tabs (
              id,
              agent_id,
              companion_id,
              browser,
              profile_id,
              window_id,
              tab_id,
              url,
              title,
              active_in_window,
              focused_window,
              focused_active,
              incognito,
              last_seen_at,
              last_focused_at,
              metadata_json,
              created_at,
              updated_at
            ) VALUES (
              'tab-row-1',
              '${agentId}',
              '${companionId}',
              'chrome',
              'profile-1',
              '${windowId}',
              '${tabId}',
              '${url}',
              'Speaker Portal Submissions',
              1,
              1,
              1,
              0,
              '${nowIso}',
              '${nowIso}',
              '{}',
              '${nowIso}',
              '${nowIso}'
            );
            INSERT INTO life_browser_page_contexts (
              id,
              agent_id,
              browser,
              profile_id,
              window_id,
              tab_id,
              url,
              title,
              selection_text,
              main_text,
              headings_json,
              links_json,
              forms_json,
              captured_at,
              metadata_json
            ) VALUES (
              'page-row-1',
              '${agentId}',
              'chrome',
              'profile-1',
              '${windowId}',
              '${tabId}',
              '${url}',
              'Speaker Portal Submissions',
              'selected deck details',
              'Speaker portal submissions and review queue',
              '["Submissions","Review queue"]',
              '[{"text":"Back to dashboard","href":"https://speaker-portal.example.com/dashboard"}]',
              '[{"action":"https://speaker-portal.example.com/submissions","fields":["deckUrl","speakerName"]}]',
              '${nowIso}',
              '{}'
            );
          `,
        },
      ],
    });

    const rows = (await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            SELECT url, title, selection_text, main_text, headings_json, links_json, forms_json
              FROM life_browser_page_contexts
             WHERE agent_id = '${agentId}'
               AND browser = 'chrome'
               AND profile_id = 'profile-1'
               AND window_id = '${windowId}'
               AND tab_id = '${tabId}'
             LIMIT 1
          `,
        },
      ],
    })) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url,
      title: "Speaker Portal Submissions",
      selection_text: "selected deck details",
      main_text: "Speaker portal submissions and review queue",
    });
    expect(rows[0]?.headings_json).toBe('["Submissions","Review queue"]');
    expect(rows[0]?.links_json).toContain("Back to dashboard");
    expect(rows[0]?.forms_json).toContain("speakerName");
  });
});
