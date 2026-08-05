import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatCatalogSummary,
  parseToolsMd,
  searchCatalog,
} from "../src/catalog/parse-tools-md.ts";
import {
  readClawdBrowserConfig,
  resolveToolsMdPath,
} from "../src/config.ts";
import { ClawdBrowserCatalogService } from "../src/services/catalog-service.ts";

const REAL_TOOLS_MD = "/Users/8bit/ClawdBrowser/tools.md";

describe("parseToolsMd (real ClawdBrowser tools.md)", () => {
  it("parses live tools.md with groups and core tools", () => {
    const md = readFileSync(REAL_TOOLS_MD, "utf8");
    const catalog = parseToolsMd(md, REAL_TOOLS_MD);

    expect(catalog.sourcePath).toBe(REAL_TOOLS_MD);
    expect(catalog.totalTools).toBeGreaterThanOrEqual(150);
    expect(catalog.coreCount).toBeGreaterThanOrEqual(100);
    expect(catalog.groups.length).toBeGreaterThanOrEqual(8);

    const phoenix = catalog.toolsByName.get("get_phoenix_mark_price");
    expect(phoenix).toBeDefined();
    expect(phoenix!.groupId).toBe("phoenix");
    expect(phoenix!.core).toBe(true);
    expect(phoenix!.description.toLowerCase()).toContain("mark");

    const swap = catalog.toolsByName.get("prepare_user_swap");
    expect(swap).toBeDefined();
    expect(swap!.core).toBe(true);
  });

  it("search finds phoenix funding tools", () => {
    const md = readFileSync(REAL_TOOLS_MD, "utf8");
    const catalog = parseToolsMd(md, REAL_TOOLS_MD);
    const hits = searchCatalog(catalog, "phoenix funding", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some((h) => h.name.includes("funding") || h.name.includes("phoenix")),
    ).toBe(true);
  });

  it("formatCatalogSummary includes totals", () => {
    const md = readFileSync(REAL_TOOLS_MD, "utf8");
    const catalog = parseToolsMd(md, REAL_TOOLS_MD);
    const summary = formatCatalogSummary(catalog);
    expect(summary).toContain("Total tools");
    expect(summary).toContain("SEARCH_CLAWD_TOOLS");
  });
});

describe("config + service", () => {
  it("resolves default tools.md path", () => {
    const path = resolveToolsMdPath(() => undefined);
    expect(path).toBe(REAL_TOOLS_MD);
  });

  it("honors CLAWDBROWSER_TOOLS_MD setting", () => {
    const cfg = readClawdBrowserConfig((k) =>
      k === "CLAWDBROWSER_TOOLS_MD" ? REAL_TOOLS_MD : undefined,
    );
    expect(cfg.toolsMdPath).toBe(REAL_TOOLS_MD);
    expect(cfg.enabled).toBe(true);
  });

  it("ClawdBrowserCatalogService loads and searches", () => {
    const svc = new ClawdBrowserCatalogService((k) =>
      k === "CLAWDBROWSER_TOOLS_MD" ? REAL_TOOLS_MD : undefined,
    );
    const catalog = svc.load();
    expect(catalog).not.toBeNull();
    expect(catalog!.totalTools).toBeGreaterThan(100);
    const hits = svc.search("wallet pnl");
    expect(hits.length).toBeGreaterThan(0);
    const desc = svc.describe("get_pnl");
    expect(desc?.name).toBe("get_pnl");
  });
});
