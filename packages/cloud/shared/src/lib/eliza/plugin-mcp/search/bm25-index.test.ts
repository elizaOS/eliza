/**
 * Contract tests for Tier2ToolIndex — the BM25-backed discovery index behind
 * the hosted agent's SEARCH_ACTIONS op (see actions/mcp.ts).
 *
 * The core BM25 primitive has its own suite; this file owns the wrapper's
 * contract on top of it, exercised with real Tier2ToolIndex instances (no
 * BM25 mocks):
 *  - tag tokenization: buildTags splits tool names on _/- and combines them
 *    with server name and platform, so a planner asking for "issues" surfaces
 *    jira_search_issues-style tools without an exact-name query;
 *  - platform filtering and pagination: search() filters case-insensitively
 *    by platform and slices offset..offset+limit after relevance ranking (the
 *    (offset + limit) * 2 over-fetch exists so filtering does not silently
 *    shrink pages);
 *  - lifecycle: build([]) resets the index to empty (no stale results from a
 *    prior build) and getToolCount() reflects the current build.
 */
import { describe, expect, test } from "bun:test";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { toActionName } from "../utils/action-naming";
import type { Tier2ToolEntry } from "./bm25-index";
import { Tier2ToolIndex } from "./bm25-index";

/** Mirrors how service.ts builds Tier-2 entries from a server's MCP tools. */
function makeEntry(serverName: string, toolName: string, description: string): Tier2ToolEntry {
  const tool: Tool = { name: toolName, description, inputSchema: { type: "object" } };
  return {
    serverName,
    toolName,
    actionName: toActionName(serverName, toolName),
    platform: serverName.toLowerCase(),
    tool,
  };
}

describe("Tier2ToolIndex tag tokenization & discovery", () => {
  const jiraTools = [
    makeEntry("jira", "jira_search_issues", "Search Jira issues by text"),
    makeEntry("jira", "jira_get_issue", "Fetch a single Jira issue"),
    makeEntry("jira", "jira_create_issue", "Create a new Jira issue"),
    makeEntry("jira", "jira_get-comments", "List the comments on a Jira issue"),
  ];

  test("finds a tool by its full action name", () => {
    const index = new Tier2ToolIndex();
    index.build(jiraTools);

    const results = index.search("JIRA_SEARCH_ISSUES");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].actionName).toBe("JIRA_SEARCH_ISSUES");
  });

  test("finds a tool by a fragment of its name, not just the exact name", () => {
    const index = new Tier2ToolIndex();
    index.build(jiraTools);

    // "issues" is a token of jira_search_issues; the planner need not name
    // the tool exactly to discover it.
    const results = index.search("issues");

    expect(results.map((r) => r.actionName)).toContain("JIRA_SEARCH_ISSUES");
    expect(results[0].actionName).toBe("JIRA_SEARCH_ISSUES");
  });

  test("finds a tool by a hyphenated name fragment", () => {
    const index = new Tier2ToolIndex();
    index.build(jiraTools);

    // buildTags splits toolName on "-", so "comments" surfaces
    // jira_get-comments even though the action name never says "comments".
    const results = index.search("comments");

    expect(results.map((r) => r.actionName)).toContain("JIRA_GET_COMMENTS");
    expect(results[0].actionName).toBe("JIRA_GET_COMMENTS");
  });

  test("finds tools by server and platform terms", () => {
    const index = new Tier2ToolIndex();
    index.build([
      ...jiraTools,
      makeEntry("github", "github_create_issue", "Open a GitHub issue"),
      makeEntry("slack", "slack_post_message", "Post a message to Slack"),
    ]);

    const results = index.search("jira");

    expect(results.length).toBe(4);
    expect(results.every((r) => r.platform === "jira")).toBe(true);
  });

  test("tag tokens carry name fragments the action name drops", () => {
    const index = new Tier2ToolIndex();
    // Action names normalize away non-ASCII tokens, so the CJK fragment
    // survives only in the tag field — tags are its sole carrier.
    index.build([
      makeEntry("jira", "jira_查询_问题", ""),
      makeEntry("github", "github_create_issue", "Open a GitHub issue"),
    ]);

    const results = index.search("问题");

    expect(results.map((r) => r.actionName)).toContain("JIRA_JIRA");
  });

  test("returns no results before any build", () => {
    const index = new Tier2ToolIndex();

    expect(index.search("issues")).toEqual([]);
  });
});

describe("Tier2ToolIndex relevance ordering", () => {
  test("a name match outranks description-only matches and unrelated entries", () => {
    const index = new Tier2ToolIndex();
    index.build([
      makeEntry("crm", "crm_get_customer", "Look up account details and contacts"),
      makeEntry("fin", "fin_summarize", "Customer churn summary report"),
      makeEntry("sales", "sales_forecast", "Quarterly revenue forecast"),
    ]);

    const results = index.search("customer");

    expect(results.map((r) => r.actionName)).toEqual(["CRM_GET_CUSTOMER", "FIN_SUMMARIZE"]);
  });
});

describe("Tier2ToolIndex platform filtering & pagination", () => {
  // Alternating GitHub/Jira docs with identical token counts, so every doc
  // scores equally for the "issues" query and doc order decides placement.
  function buildAlternating(githubCount: number, jiraCount: number): Tier2ToolEntry[] {
    const entries: Tier2ToolEntry[] = [];
    for (let i = 0; i < Math.max(githubCount, jiraCount); i++) {
      if (i < githubCount)
        entries.push(makeEntry("github", "github_create_issues", "Work with GitHub issues"));
      if (i < jiraCount)
        entries.push(makeEntry("jira", "jira_create_issues", "Work with Jira issues"));
    }
    return entries;
  }

  test("filters case-insensitively by platform and excludes other platforms", () => {
    const index = new Tier2ToolIndex();
    index.build(buildAlternating(0, 6));

    const mixedCase = index.search("issues", "JIRA");
    expect(mixedCase.length).toBe(6);
    expect(mixedCase.every((r) => r.platform === "jira")).toBe(true);

    expect(index.search("issues", "salesforce")).toEqual([]);
    expect(index.search("issues", "GITHUB")).toEqual([]);
  });

  test("slices offset..offset+limit after filtering", () => {
    const index = new Tier2ToolIndex();
    index.build(buildAlternating(6, 6));

    const allJira = index.search("issues", "jira", 10, 0);
    expect(allJira).toHaveLength(6);

    const pages = [0, 2, 4].map((offset) => index.search("issues", "jira", 2, offset));
    expect(pages.map((p) => p.length)).toEqual([2, 2, 2]);
    expect(pages.every((p) => p.every((r) => r.platform === "jira"))).toBe(true);
    expect(pages.flat().map((r) => r.actionName)).toEqual(allJira.map((r) => r.actionName));
  });

  test("over-fetches past the platform filter so pages do not silently shrink", () => {
    const index = new Tier2ToolIndex();
    index.build(buildAlternating(10, 10));

    // The first (offset + limit) raw results are half GitHub docs; without the
    // (offset + limit) * 2 over-fetch the filtered page would come up short.
    const results = index.search("issues", "jira", 3, 2);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.platform === "jira")).toBe(true);
  });
});

describe("Tier2ToolIndex lifecycle", () => {
  test("build() replaces the previous build completely", () => {
    const index = new Tier2ToolIndex();
    index.build([makeEntry("jira", "jira_search_issues", "Search Jira issues")]);
    expect(index.search("issues")).toHaveLength(1);
    expect(index.getToolCount()).toBe(1);

    index.build([makeEntry("slack", "slack_post_message", "Post a message to Slack")]);

    expect(index.search("issues")).toEqual([]);
    expect(index.search("slack").map((r) => r.actionName)).toEqual(["SLACK_POST_MESSAGE"]);
    expect(index.getToolCount()).toBe(1);
  });

  test("build([]) resets the index to empty", () => {
    const index = new Tier2ToolIndex();
    index.build([makeEntry("jira", "jira_search_issues", "Search Jira issues")]);
    expect(index.search("issues")).toHaveLength(1);

    index.build([]);

    expect(index.search("issues")).toEqual([]);
    expect(index.getToolCount()).toBe(0);
  });

  test("an empty build reports zero tools", () => {
    const index = new Tier2ToolIndex();

    expect(index.getToolCount()).toBe(0);
    index.build([]);
    expect(index.getToolCount()).toBe(0);
  });
});
