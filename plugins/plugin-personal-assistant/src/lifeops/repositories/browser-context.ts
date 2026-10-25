/** Adapts LifeOps browser context persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  BrowserBridgePageContext,
  BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser";
import {
  executeRawSql,
  sqlBoolean,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  parseBrowserPageContext,
  parseBrowserTabSummary,
} from "./browser-records.js";
import { resolveBrowserBridgeTable } from "./browser-tables.js";
export class BrowserContextRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertBrowserTab(tab: BrowserBridgeTabSummary): Promise<void> {
    const tabsTable = await resolveBrowserBridgeTable(this.runtime, "tabs");
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${tabsTable} (
        id, agent_id, companion_id, browser, profile_id, window_id, tab_id,
        url, title, active_in_window, focused_window, focused_active,
        incognito, favicon_url, last_seen_at, last_focused_at, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(tab.id)},
        ${sqlQuote(tab.agentId)},
        ${sqlText(tab.companionId)},
        ${sqlQuote(tab.browser)},
        ${sqlQuote(tab.profileId)},
        ${sqlQuote(tab.windowId)},
        ${sqlQuote(tab.tabId)},
        ${sqlQuote(tab.url)},
        ${sqlQuote(tab.title)},
        ${sqlBoolean(tab.activeInWindow)},
        ${sqlBoolean(tab.focusedWindow)},
        ${sqlBoolean(tab.focusedActive)},
        ${sqlBoolean(tab.incognito)},
        ${sqlText(tab.faviconUrl)},
        ${sqlQuote(tab.lastSeenAt)},
        ${sqlText(tab.lastFocusedAt)},
        ${sqlJson(tab.metadata)},
        ${sqlQuote(tab.createdAt)},
        ${sqlQuote(tab.updatedAt)}
      )
      ON CONFLICT(agent_id, browser, profile_id, window_id, tab_id) DO UPDATE SET
        companion_id = excluded.companion_id,
        url = excluded.url,
        title = excluded.title,
        active_in_window = excluded.active_in_window,
        focused_window = excluded.focused_window,
        focused_active = excluded.focused_active,
        incognito = excluded.incognito,
        favicon_url = excluded.favicon_url,
        last_seen_at = excluded.last_seen_at,
        last_focused_at = excluded.last_focused_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listBrowserTabs(agentId: string): Promise<BrowserBridgeTabSummary[]> {
    const tabsTable = await resolveBrowserBridgeTable(this.runtime, "tabs");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${tabsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY focused_active DESC,
                 active_in_window DESC,
                 COALESCE(last_focused_at, last_seen_at) DESC,
                 updated_at DESC`,
    );
    return rows.map(parseBrowserTabSummary);
  }

  async deleteBrowserTabsByIds(agentId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    const tabsTable = await resolveBrowserBridgeTable(this.runtime, "tabs");
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${tabsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserTabs(agentId: string): Promise<void> {
    const tabsTable = await resolveBrowserBridgeTable(this.runtime, "tabs");
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${tabsTable}
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  async upsertBrowserPageContext(
    context: BrowserBridgePageContext,
  ): Promise<void> {
    const pageContextsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "pageContexts",
    );
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${pageContextsTable} (
        id, agent_id, browser, profile_id, window_id, tab_id, url, title,
        selection_text, main_text, headings_json, links_json, forms_json,
        captured_at, metadata_json
      ) VALUES (
        ${sqlQuote(context.id)},
        ${sqlQuote(context.agentId)},
        ${sqlQuote(context.browser)},
        ${sqlQuote(context.profileId)},
        ${sqlQuote(context.windowId)},
        ${sqlQuote(context.tabId)},
        ${sqlQuote(context.url)},
        ${sqlQuote(context.title)},
        ${sqlText(context.selectionText)},
        ${sqlText(context.mainText)},
        ${sqlJson(context.headings)},
        ${sqlJson(context.links)},
        ${sqlJson(context.forms)},
        ${sqlQuote(context.capturedAt)},
        ${sqlJson(context.metadata)}
      )
      ON CONFLICT(agent_id, browser, profile_id, window_id, tab_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        selection_text = excluded.selection_text,
        main_text = excluded.main_text,
        headings_json = excluded.headings_json,
        links_json = excluded.links_json,
        forms_json = excluded.forms_json,
        captured_at = excluded.captured_at,
        metadata_json = excluded.metadata_json`,
    );
  }

  async listBrowserPageContexts(
    agentId: string,
  ): Promise<BrowserBridgePageContext[]> {
    const pageContextsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "pageContexts",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${pageContextsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY captured_at DESC`,
    );
    return rows.map(parseBrowserPageContext);
  }

  async deleteBrowserPageContextsByIds(
    agentId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    const pageContextsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "pageContexts",
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${pageContextsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserPageContexts(agentId: string): Promise<void> {
    const pageContextsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "pageContexts",
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM ${pageContextsTable}
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }
}
