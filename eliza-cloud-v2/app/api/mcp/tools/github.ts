/**
 * GitHub MCP Tools - Repos, Issues, PRs
 * Uses per-organization OAuth tokens via oauthService.
 */

import type { McpServer } from "mcp-handler";
import { z } from "zod3";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

async function getGitHubToken(): Promise<string> {
  const { user } = getAuthContext();
  try {
    const result = await oauthService.getValidTokenByPlatform({
      organizationId: user.organization_id,
      platform: "github",
    });
    return result.accessToken;
  } catch (error) {
    logger.warn("[GitHubMCP] Failed to get token", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("GitHub account not connected. Connect in Settings > Connections.");
  }
}

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const token = await getGitHubToken();
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok && response.status !== 204) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `GitHub API error: ${response.status}`);
  }

  if (response.status === 204) return {};
  const text = await response.text();
  if (!text || !text.trim()) return {};
  return JSON.parse(text);
}

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) sp.set(key, String(value));
  });
  const query = sp.toString();
  return query ? `?${query}` : "";
}

export function registerGitHubTools(server: McpServer): void {
  server.registerTool(
    "github_status",
    {
      description: "Check GitHub OAuth connection status",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const connections = await oauthService.listConnections({
          organizationId: user.organization_id,
          platform: "github",
        });
        const active = connections.find((c) => c.status === "active");
        if (!active) {
          return jsonResponse({
            connected: false,
            message: "GitHub not connected. Connect in Settings > Connections.",
          });
        }
        return jsonResponse({
          connected: true,
          email: active.email,
          scopes: active.scopes,
          linkedAt: active.linkedAt,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to check status"));
      }
    },
  );

  server.registerTool(
    "github_list_repos",
    {
      description: "List user or org repos",
      inputSchema: {
        org: z.string().optional(),
        type: z.string().optional(),
        sort: z.string().optional(),
        direction: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ org, type, sort, direction, per_page, page }) => {
      try {
        const base = org ? `/orgs/${org}/repos` : "/user/repos";
        const data = await githubFetch(`${base}${buildQuery({ type, sort, direction, per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list repos"));
      }
    },
  );

  server.registerTool(
    "github_get_repo",
    {
      description: "Get repository",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
      },
    },
    async ({ owner, repo }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get repo"));
      }
    },
  );

  server.registerTool(
    "github_create_repo",
    {
      description: "Create repository",
      inputSchema: {
        org: z.string().optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        private: z.boolean().optional(),
        homepage: z.string().optional(),
        has_issues: z.boolean().optional(),
        has_projects: z.boolean().optional(),
        has_wiki: z.boolean().optional(),
        auto_init: z.boolean().optional(),
        gitignore_template: z.string().optional(),
        license_template: z.string().optional(),
      },
    },
    async ({ org, name, ...rest }) => {
      try {
        const endpoint = org ? `/orgs/${org}/repos` : "/user/repos";
        const data = await githubFetch(endpoint, {
          method: "POST",
          body: JSON.stringify({ name, ...rest }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create repo"));
      }
    },
  );

  server.registerTool(
    "github_update_repo",
    {
      description: "Update repository",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        homepage: z.string().optional(),
        private: z.boolean().optional(),
        has_issues: z.boolean().optional(),
        has_projects: z.boolean().optional(),
        has_wiki: z.boolean().optional(),
        default_branch: z.string().optional(),
      },
    },
    async ({ owner, repo, ...rest }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}`, {
          method: "PATCH",
          body: JSON.stringify(rest),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update repo"));
      }
    },
  );

  server.registerTool(
    "github_delete_repo",
    {
      description: "Delete repository",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
      },
    },
    async ({ owner, repo }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}`, { method: "DELETE" });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete repo"));
      }
    },
  );

  server.registerTool(
    "github_list_issues",
    {
      description: "List issues",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        state: z.string().optional(),
        labels: z.string().optional(),
        assignee: z.string().optional(),
        creator: z.string().optional(),
        mentioned: z.string().optional(),
        since: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, ...params }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues${buildQuery(params)}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list issues"));
      }
    },
  );

  server.registerTool(
    "github_get_issue",
    {
      description: "Get issue",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
      },
    },
    async ({ owner, repo, issue_number }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get issue"));
      }
    },
  );

  server.registerTool(
    "github_create_issue",
    {
      description: "Create issue",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        body: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        milestone: z.number().int().optional(),
      },
    },
    async ({ owner, repo, title, body, assignees, labels, milestone }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title, body, assignees, labels, milestone }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create issue"));
      }
    },
  );

  server.registerTool(
    "github_update_issue",
    {
      description: "Update issue",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
        title: z.string().optional(),
        body: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        milestone: z.number().int().optional(),
        state: z.string().optional(),
      },
    },
    async ({ owner, repo, issue_number, ...rest }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`, {
          method: "PATCH",
          body: JSON.stringify(rest),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update issue"));
      }
    },
  );

  server.registerTool(
    "github_close_issue",
    {
      description: "Close issue",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
      },
    },
    async ({ owner, repo, issue_number }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to close issue"));
      }
    },
  );

  server.registerTool(
    "github_lock_issue",
    {
      description: "Lock issue",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
        lock_reason: z.string().optional(),
      },
    },
    async ({ owner, repo, issue_number, lock_reason }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}/lock`, {
          method: "PUT",
          body: lock_reason ? JSON.stringify({ lock_reason }) : undefined,
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to lock issue"));
      }
    },
  );

  server.registerTool(
    "github_list_issue_comments",
    {
      description: "List issue comments",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, issue_number, per_page, page }) => {
      try {
        const data = await githubFetch(
          `/repos/${owner}/${repo}/issues/${issue_number}/comments${buildQuery({ per_page, page })}`,
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list issue comments"));
      }
    },
  );

  server.registerTool(
    "github_create_issue_comment",
    {
      description: "Create issue comment",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        issue_number: z.number().int().min(1),
        body: z.string().min(1),
      },
    },
    async ({ owner, repo, issue_number, body }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create issue comment"));
      }
    },
  );

  server.registerTool(
    "github_update_issue_comment",
    {
      description: "Update issue comment",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        comment_id: z.number().int().min(1),
        body: z.string().min(1),
      },
    },
    async ({ owner, repo, comment_id, body }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/comments/${comment_id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update issue comment"));
      }
    },
  );

  server.registerTool(
    "github_delete_issue_comment",
    {
      description: "Delete issue comment",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        comment_id: z.number().int().min(1),
      },
    },
    async ({ owner, repo, comment_id }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/issues/comments/${comment_id}`, { method: "DELETE" });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete issue comment"));
      }
    },
  );

  server.registerTool(
    "github_list_prs",
    {
      description: "List pull requests",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        state: z.string().optional(),
        head: z.string().optional(),
        base: z.string().optional(),
        sort: z.string().optional(),
        direction: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, ...params }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls${buildQuery(params)}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list PRs"));
      }
    },
  );

  server.registerTool(
    "github_get_pr",
    {
      description: "Get pull request",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1),
      },
    },
    async ({ owner, repo, pull_number }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get PR"));
      }
    },
  );

  server.registerTool(
    "github_create_pr",
    {
      description: "Create pull request",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        head: z.string().min(1),
        base: z.string().min(1),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      },
    },
    async ({ owner, repo, title, head, base, body, draft }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          body: JSON.stringify({ title, head, base, body, draft }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create PR"));
      }
    },
  );

  server.registerTool(
    "github_update_pr",
    {
      description: "Update pull request",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1),
        title: z.string().optional(),
        body: z.string().optional(),
        state: z.string().optional(),
        base: z.string().optional(),
        draft: z.boolean().optional(),
      },
    },
    async ({ owner, repo, pull_number, ...rest }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}`, {
          method: "PATCH",
          body: JSON.stringify(rest),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update PR"));
      }
    },
  );

  server.registerTool(
    "github_merge_pr",
    {
      description: "Merge pull request",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1),
        commit_title: z.string().optional(),
        commit_message: z.string().optional(),
        merge_method: z.string().optional(),
      },
    },
    async ({ owner, repo, pull_number, commit_title, commit_message, merge_method }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
          method: "PUT",
          body: JSON.stringify({ commit_title, commit_message, merge_method }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to merge PR"));
      }
    },
  );

  server.registerTool(
    "github_list_pr_reviews",
    {
      description: "List PR reviews",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, pull_number, per_page, page }) => {
      try {
        const data = await githubFetch(
          `/repos/${owner}/${repo}/pulls/${pull_number}/reviews${buildQuery({ per_page, page })}`,
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list PR reviews"));
      }
    },
  );

  server.registerTool(
    "github_create_pr_review",
    {
      description: "Create PR review",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1),
        body: z.string().optional(),
        event: z.string().optional(),
        comments: z.array(z.record(z.any())).optional(),
      },
    },
    async ({ owner, repo, pull_number, body, event, comments }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
          method: "POST",
          body: JSON.stringify({ body, event, comments }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create PR review"));
      }
    },
  );

  server.registerTool(
    "github_list_labels",
    {
      description: "List labels",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, per_page, page }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/labels${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list labels"));
      }
    },
  );

  server.registerTool(
    "github_create_label",
    {
      description: "Create label",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        name: z.string().min(1),
        color: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ owner, repo, name, color, description }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/labels`, {
          method: "POST",
          body: JSON.stringify({ name, color, description }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create label"));
      }
    },
  );

  server.registerTool(
    "github_update_label",
    {
      description: "Update label",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        name: z.string().min(1),
        new_name: z.string().optional(),
        color: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ owner, repo, name, new_name, color, description }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: JSON.stringify({ new_name, color, description }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update label"));
      }
    },
  );

  server.registerTool(
    "github_delete_label",
    {
      description: "Delete label",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        name: z.string().min(1),
      },
    },
    async ({ owner, repo, name }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete label"));
      }
    },
  );

  server.registerTool(
    "github_list_milestones",
    {
      description: "List milestones",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        state: z.string().optional(),
        sort: z.string().optional(),
        direction: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, ...params }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/milestones${buildQuery(params)}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list milestones"));
      }
    },
  );

  server.registerTool(
    "github_create_milestone",
    {
      description: "Create milestone",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        title: z.string().min(1),
        state: z.string().optional(),
        description: z.string().optional(),
        due_on: z.string().optional(),
      },
    },
    async ({ owner, repo, title, state, description, due_on }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/milestones`, {
          method: "POST",
          body: JSON.stringify({ title, state, description, due_on }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create milestone"));
      }
    },
  );

  server.registerTool(
    "github_update_milestone",
    {
      description: "Update milestone",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        milestone_number: z.number().int().min(1),
        title: z.string().optional(),
        state: z.string().optional(),
        description: z.string().optional(),
        due_on: z.string().optional(),
      },
    },
    async ({ owner, repo, milestone_number, ...rest }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/milestones/${milestone_number}`, {
          method: "PATCH",
          body: JSON.stringify(rest),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update milestone"));
      }
    },
  );

  server.registerTool(
    "github_delete_milestone",
    {
      description: "Delete milestone",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        milestone_number: z.number().int().min(1),
      },
    },
    async ({ owner, repo, milestone_number }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/milestones/${milestone_number}`, { method: "DELETE" });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete milestone"));
      }
    },
  );

  server.registerTool(
    "github_list_orgs",
    {
      description: "List user orgs",
      inputSchema: {
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ per_page, page }) => {
      try {
        const data = await githubFetch(`/user/orgs${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list orgs"));
      }
    },
  );

  server.registerTool(
    "github_get_org",
    {
      description: "Get organization",
      inputSchema: {
        org: z.string().min(1),
      },
    },
    async ({ org }) => {
      try {
        const data = await githubFetch(`/orgs/${org}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get org"));
      }
    },
  );

  server.registerTool(
    "github_list_org_members",
    {
      description: "List org members",
      inputSchema: {
        org: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ org, per_page, page }) => {
      try {
        const data = await githubFetch(`/orgs/${org}/members${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list org members"));
      }
    },
  );

  server.registerTool(
    "github_list_teams",
    {
      description: "List teams",
      inputSchema: {
        org: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ org, per_page, page }) => {
      try {
        const data = await githubFetch(`/orgs/${org}/teams${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list teams"));
      }
    },
  );

  server.registerTool(
    "github_get_team",
    {
      description: "Get team",
      inputSchema: {
        org: z.string().min(1),
        team_slug: z.string().min(1),
      },
    },
    async ({ org, team_slug }) => {
      try {
        const data = await githubFetch(`/orgs/${org}/teams/${team_slug}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get team"));
      }
    },
  );

  server.registerTool(
    "github_list_team_members",
    {
      description: "List team members",
      inputSchema: {
        org: z.string().min(1),
        team_slug: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ org, team_slug, per_page, page }) => {
      try {
        const data = await githubFetch(`/orgs/${org}/teams/${team_slug}/members${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list team members"));
      }
    },
  );

  server.registerTool(
    "github_list_branches",
    {
      description: "List branches",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, per_page, page }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/branches${buildQuery({ per_page, page })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list branches"));
      }
    },
  );

  server.registerTool(
    "github_get_branch",
    {
      description: "Get branch",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1),
      },
    },
    async ({ owner, repo, branch }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get branch"));
      }
    },
  );

  server.registerTool(
    "github_delete_branch",
    {
      description: "Delete branch",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1),
      },
    },
    async ({ owner, repo, branch }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          method: "DELETE",
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete branch"));
      }
    },
  );

  server.registerTool(
    "github_list_commits",
    {
      description: "List commits",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        sha: z.string().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, ...params }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/commits${buildQuery(params)}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list commits"));
      }
    },
  );

  server.registerTool(
    "github_get_commit",
    {
      description: "Get commit",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().min(1),
      },
    },
    async ({ owner, repo, ref }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/commits/${ref}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get commit"));
      }
    },
  );

  server.registerTool(
    "github_get_file",
    {
      description: "Get file contents",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().optional(),
      },
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}${buildQuery({ ref })}`);
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get file"));
      }
    },
  );

  server.registerTool(
    "github_create_file",
    {
      description: "Create file",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        message: z.string().min(1),
        content: z.string().min(1),
        branch: z.string().optional(),
        committer: z.record(z.any()).optional(),
        author: z.record(z.any()).optional(),
      },
    },
    async ({ owner, repo, path, message, content, branch, committer, author }) => {
      try {
        const encodedContent = Buffer.from(content).toString("base64");
        const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}`, {
          method: "PUT",
          body: JSON.stringify({ message, content: encodedContent, branch, committer, author }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create file"));
      }
    },
  );

  server.registerTool(
    "github_update_file",
    {
      description: "Update file",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        message: z.string().min(1),
        content: z.string().min(1),
        sha: z.string().min(1),
        branch: z.string().optional(),
        committer: z.record(z.any()).optional(),
        author: z.record(z.any()).optional(),
      },
    },
    async ({ owner, repo, path, message, content, sha, branch, committer, author }) => {
      try {
        const encodedContent = Buffer.from(content).toString("base64");
        const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}`, {
          method: "PUT",
          body: JSON.stringify({ message, content: encodedContent, sha, branch, committer, author }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update file"));
      }
    },
  );

  server.registerTool(
    "github_delete_file",
    {
      description: "Delete file",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1),
        message: z.string().min(1),
        sha: z.string().min(1),
        branch: z.string().optional(),
        committer: z.record(z.any()).optional(),
        author: z.record(z.any()).optional(),
      },
    },
    async ({ owner, repo, path, message, sha, branch, committer, author }) => {
      try {
        const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}`, {
          method: "DELETE",
          body: JSON.stringify({ message, sha, branch, committer, author }),
        });
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete file"));
      }
    },
  );
}
