/**
 * Two-tier action visibility for MCP tools.
 * Tier 1 (crucial): Always visible to the LLM in the prompt.
 * Tier 2 (discoverable): Only found via SEARCH_ACTIONS using BM25.
 */

import { toActionName } from "./utils/action-naming";

/**
 * Map of provider -> list of crucial tool action names.
 * These are the 3-5 most important actions per provider that should always be visible.
 * Names here must match the raw tool names from MCP servers (before normalization).
 */
const CRUCIAL_TOOLS: Record<string, string[]> = {
  google: [
    "google_status",
    "gmail_list",
    "gmail_send",
    "calendar_list_events",
    "calendar_create_event",
  ],
  linear: [
    "linear_status",
    "linear_list_issues",
    "linear_create_issue",
    "linear_update_issue",
    "linear_list_projects",
  ],
  github: [
    "github_status",
    "github_list_repos",
    "github_list_prs",
    "github_create_issue",
    "github_create_pr",
  ],
  notion: [
    "notion_status",
    "notion_search",
    "notion_get_page",
    "notion_create_page",
    "notion_query_data_source",
  ],
  asana: [
    "asana_status",
    "asana_list_projects",
    "asana_list_tasks",
    "asana_create_task",
    "asana_update_task",
  ],
  dropbox: [
    "dropbox_status",
    "dropbox_list_folder",
    "dropbox_search",
    "dropbox_upload_text",
    "dropbox_create_shared_link",
  ],
  salesforce: [
    "salesforce_status",
    "salesforce_query",
    "salesforce_search",
    "salesforce_get_record",
    "salesforce_update_record",
  ],
  airtable: [
    "airtable_status",
    "airtable_list_bases",
    "airtable_list_records",
    "airtable_search_records",
    "airtable_create_records",
  ],
  zoom: [
    "zoom_status",
    "zoom_list_meetings",
    "zoom_get_meeting",
    "zoom_create_meeting",
    "zoom_update_meeting",
  ],
  jira: [
    "jira_status",
    "jira_search_issues",
    "jira_get_issue",
    "jira_create_issue",
    "jira_update_issue",
  ],
  linkedin: [
    "linkedin_status",
    "linkedin_get_profile",
    "linkedin_create_post",
    "linkedin_delete_post",
  ],
  twitter: [
    "twitter_status",
    "twitter_get_me",
    "twitter_get_my_tweets",
    "twitter_get_mentions",
    "twitter_create_tweet",
    "twitter_search_tweets",
  ],
  microsoft: [
    "microsoft_status",
    "outlook_list",
    "outlook_send",
    "calendar_list_events",
    "calendar_create_event",
  ],
};

/**
 * Pre-computed set of normalized crucial action names for fast lookup.
 * Built lazily on first access.
 */
let crucialActionNamesCache: Set<string> | null = null;

function buildCrucialActionNamesSet(): Set<string> {
  if (crucialActionNamesCache) return crucialActionNamesCache;

  const set = new Set<string>();
  for (const [server, tools] of Object.entries(CRUCIAL_TOOLS)) {
    for (const tool of tools) {
      set.add(toActionName(server, tool));
    }
  }
  crucialActionNamesCache = set;
  return set;
}

/**
 * Checks whether a tool is classified as crucial (Tier 1) for the given server.
 * Uses the same normalization as plugin-mcp's action naming.
 */
export function isCrucialTool(serverName: string, toolName: string): boolean {
  const actionName = toActionName(serverName, toolName);
  return buildCrucialActionNamesSet().has(actionName);
}

/**
 * Returns the list of crucial tool names for a given server.
 */
export function getCrucialToolsForServer(serverName: string): string[] {
  return CRUCIAL_TOOLS[serverName.toLowerCase()] ?? [];
}

/**
 * Returns a copy of all crucial tools configuration.
 */
export function getAllCrucialTools(): Record<string, string[]> {
  return { ...CRUCIAL_TOOLS };
}
