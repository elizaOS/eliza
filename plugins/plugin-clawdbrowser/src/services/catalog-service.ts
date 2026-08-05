/**
 * Loads and caches the ClawdBrowser tools.md catalog for the runtime.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  type ClawdBrowserCatalog,
  parseToolsMd,
  searchCatalog,
} from "../catalog/parse-tools-md.js";
import { readClawdBrowserConfig } from "../config.js";

export const CLAWDBROWSER_SERVICE_TYPE = "clawdbrowser-catalog";

export class ClawdBrowserCatalogService {
  static serviceType = CLAWDBROWSER_SERVICE_TYPE;
  capabilityDescription =
    "ClawdBrowser SOL GPT tool catalog (tools.md) — search/list/describe";

  private catalog: ClawdBrowserCatalog | null = null;
  private mtimeMs = 0;
  private lastError: string | null = null;

  constructor(
    private getSetting: (key: string) => string | undefined | null = (k) =>
      process.env[k],
  ) {}

  static async start(runtime: {
    getSetting: (k: string) => string | undefined | null;
  }): Promise<ClawdBrowserCatalogService> {
    const svc = new ClawdBrowserCatalogService((k) => runtime.getSetting(k));
    svc.load();
    return svc;
  }

  async stop(): Promise<void> {
    this.catalog = null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getCatalog(): ClawdBrowserCatalog | null {
    this.reloadIfStale();
    return this.catalog;
  }

  /** Force (re)load from disk. */
  load(): ClawdBrowserCatalog | null {
    const cfg = readClawdBrowserConfig(this.getSetting);
    if (!cfg.enabled) {
      this.lastError = "CLAWDBROWSER_ENABLED=false";
      this.catalog = null;
      return null;
    }
    const path = cfg.toolsMdPath;
    if (!path) {
      this.lastError =
        "tools.md not found — set CLAWDBROWSER_TOOLS_MD or CLAWDBROWSER_ROOT";
      this.catalog = null;
      return null;
    }
    if (!existsSync(path)) {
      this.lastError = `tools.md missing at ${path}`;
      this.catalog = null;
      return null;
    }
    try {
      const md = readFileSync(path, "utf8");
      this.catalog = parseToolsMd(md, path);
      this.mtimeMs = statSync(path).mtimeMs;
      this.lastError = null;
      return this.catalog;
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : `failed to read ${path}`;
      this.catalog = null;
      return null;
    }
  }

  private reloadIfStale(): void {
    const cfg = readClawdBrowserConfig(this.getSetting);
    const path = cfg.toolsMdPath;
    if (!path || !existsSync(path)) return;
    try {
      const m = statSync(path).mtimeMs;
      if (m !== this.mtimeMs) this.load();
    } catch {
      /* ignore */
    }
  }

  search(query: string, limit = 20) {
    const c = this.getCatalog();
    if (!c) return [];
    return searchCatalog(c, query, limit);
  }

  describe(name: string) {
    const c = this.getCatalog();
    if (!c) return null;
    return c.toolsByName.get(name) || c.toolsByName.get(name.trim()) || null;
  }

  listGroup(groupIdOrName?: string) {
    const c = this.getCatalog();
    if (!c) return [];
    if (!groupIdOrName) {
      return [...c.toolsByName.values()];
    }
    const key = groupIdOrName.toLowerCase();
    return [...c.toolsByName.values()].filter(
      (t) =>
        t.groupId === key ||
        t.group.toLowerCase() === key ||
        t.group.toLowerCase().includes(key),
    );
  }
}
