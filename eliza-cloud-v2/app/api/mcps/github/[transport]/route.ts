/**
 * GitHub MCP Server - Repos, Issues, PRs
 *
 * Standalone MCP endpoint for GitHub tools with per-org OAuth.
 * Config: { "type": "streamable-http", "url": "/api/mcps/github/streamable-http" }
 */

import type { NextRequest } from "next/server";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { authContextStorage } from "@/app/api/mcp/lib/context";
import { checkRateLimitRedis } from "@/lib/middleware/rate-limit-redis";

export const maxDuration = 60;

interface McpHandlerResponse {
  status: number;
  headers?: Headers;
  text?: () => Promise<string>;
}

function isMcpHandlerResponse(resp: unknown): resp is McpHandlerResponse {
  return typeof resp === "object" && resp !== null && typeof (resp as McpHandlerResponse).status === "number";
}

let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

async function getGitHubMcpHandler() {
  if (mcpHandler) return mcpHandler;

  const { createMcpHandler } = await import("mcp-handler");
  const { z } = await import("zod3");

  async function getGitHubToken(organizationId: string): Promise<string> {
    const result = await oauthService.getValidTokenByPlatform({ organizationId, platform: "github" });
    return result.accessToken;
  }

  async function githubFetch(orgId: string, endpoint: string, options: RequestInit = {}) {
    const token = await getGitHubToken(orgId);
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

  function getOrgId(): string {
    const ctx = authContextStorage.getStore();
    if (!ctx) throw new Error("Not authenticated");
    return ctx.user.organization_id;
  }

  function jsonResult(data: object) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  function errorResult(msg: string) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
  }

  function buildQuery(params: Record<string, string | number | boolean | undefined>) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) sp.set(key, String(value));
    });
    const query = sp.toString();
    return query ? `?${query}` : "";
  }

  mcpHandler = createMcpHandler(
    (server) => {
      server.tool("github_status", "Check GitHub OAuth connection status", {}, async () => {
        try {
          const orgId = getOrgId();
          const connections = await oauthService.listConnections({ organizationId: orgId, platform: "github" });
          const active = connections.find((c) => c.status === "active");
          if (!active) {
            return jsonResult({ connected: false, message: "GitHub not connected. Connect in Settings > Connections." });
          }
          return jsonResult({ connected: true, email: active.email, scopes: active.scopes, linkedAt: active.linkedAt });
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : "Failed");
        }
      });

      server.tool(
        "github_list_repos",
        "List user or org repos",
        {
          org: z.string().optional(),
          type: z.string().optional(),
          sort: z.string().optional(),
          direction: z.string().optional(),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ org, type, sort, direction, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const base = org ? `/orgs/${org}/repos` : "/user/repos";
            const data = await githubFetch(orgId, `${base}${buildQuery({ type, sort, direction, per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_repo",
        "Get repository",
        { owner: z.string().min(1), repo: z.string().min(1) },
        async ({ owner, repo }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_repo",
        "Create repository",
        {
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
        async ({ org, name, ...rest }) => {
          try {
            const orgId = getOrgId();
            const endpoint = org ? `/orgs/${org}/repos` : "/user/repos";
            const data = await githubFetch(orgId, endpoint, {
              method: "POST",
              body: JSON.stringify({ name, ...rest }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_repo",
        "Update repository",
        {
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
        async ({ owner, repo, ...rest }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}`, {
              method: "PATCH",
              body: JSON.stringify(rest),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_repo",
        "Delete repository",
        { owner: z.string().min(1), repo: z.string().min(1) },
        async ({ owner, repo }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}`, { method: "DELETE" });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_issues",
        "List issues",
        {
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
        async ({ owner, repo, ...params }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues${buildQuery(params)}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_issue",
        "Get issue",
        { owner: z.string().min(1), repo: z.string().min(1), issue_number: z.number().int().min(1) },
        async ({ owner, repo, issue_number }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/${issue_number}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_issue",
        "Create issue",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          title: z.string().min(1),
          body: z.string().optional(),
          assignees: z.array(z.string()).optional(),
          labels: z.array(z.string()).optional(),
          milestone: z.number().int().optional(),
        },
        async ({ owner, repo, title, body, assignees, labels, milestone }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues`, {
              method: "POST",
              body: JSON.stringify({ title, body, assignees, labels, milestone }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_issue",
        "Update issue",
        {
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
        async ({ owner, repo, issue_number, ...rest }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/${issue_number}`, {
              method: "PATCH",
              body: JSON.stringify(rest),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_close_issue",
        "Close issue",
        { owner: z.string().min(1), repo: z.string().min(1), issue_number: z.number().int().min(1) },
        async ({ owner, repo, issue_number }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/${issue_number}`, {
              method: "PATCH",
              body: JSON.stringify({ state: "closed" }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_lock_issue",
        "Lock issue",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          issue_number: z.number().int().min(1),
          lock_reason: z.string().optional(),
        },
        async ({ owner, repo, issue_number, lock_reason }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/${issue_number}/lock`, {
              method: "PUT",
              body: lock_reason ? JSON.stringify({ lock_reason }) : undefined,
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_issue_comments",
        "List issue comments",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          issue_number: z.number().int().min(1),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ owner, repo, issue_number, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(
              orgId,
              `/repos/${owner}/${repo}/issues/${issue_number}/comments${buildQuery({ per_page, page })}`,
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_issue_comment",
        "Create issue comment",
        { owner: z.string().min(1), repo: z.string().min(1), issue_number: z.number().int().min(1), body: z.string().min(1) },
        async ({ owner, repo, issue_number, body }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
              method: "POST",
              body: JSON.stringify({ body }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_issue_comment",
        "Update issue comment",
        { owner: z.string().min(1), repo: z.string().min(1), comment_id: z.number().int().min(1), body: z.string().min(1) },
        async ({ owner, repo, comment_id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/comments/${comment_id}`, {
              method: "PATCH",
              body: JSON.stringify({ body }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_issue_comment",
        "Delete issue comment",
        { owner: z.string().min(1), repo: z.string().min(1), comment_id: z.number().int().min(1) },
        async ({ owner, repo, comment_id }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/issues/comments/${comment_id}`, { method: "DELETE" });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_prs",
        "List pull requests",
        {
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
        async ({ owner, repo, ...params }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls${buildQuery(params)}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_pr",
        "Get pull request",
        { owner: z.string().min(1), repo: z.string().min(1), pull_number: z.number().int().min(1) },
        async ({ owner, repo, pull_number }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls/${pull_number}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_pr",
        "Create pull request",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          title: z.string().min(1),
          head: z.string().min(1),
          base: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional(),
        },
        async ({ owner, repo, title, head, base, body, draft }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls`, {
              method: "POST",
              body: JSON.stringify({ title, head, base, body, draft }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_pr",
        "Update pull request",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          pull_number: z.number().int().min(1),
          title: z.string().optional(),
          body: z.string().optional(),
          state: z.string().optional(),
          base: z.string().optional(),
          draft: z.boolean().optional(),
        },
        async ({ owner, repo, pull_number, ...rest }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls/${pull_number}`, {
              method: "PATCH",
              body: JSON.stringify(rest),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_merge_pr",
        "Merge pull request",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          pull_number: z.number().int().min(1),
          commit_title: z.string().optional(),
          commit_message: z.string().optional(),
          merge_method: z.string().optional(),
        },
        async ({ owner, repo, pull_number, commit_title, commit_message, merge_method }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
              method: "PUT",
              body: JSON.stringify({ commit_title, commit_message, merge_method }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_pr_reviews",
        "List PR reviews",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          pull_number: z.number().int().min(1),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ owner, repo, pull_number, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(
              orgId,
              `/repos/${owner}/${repo}/pulls/${pull_number}/reviews${buildQuery({ per_page, page })}`,
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_pr_review",
        "Create PR review",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          pull_number: z.number().int().min(1),
          body: z.string().optional(),
          event: z.string().optional(),
          comments: z.array(z.record(z.any())).optional(),
        },
        async ({ owner, repo, pull_number, body, event, comments }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
              method: "POST",
              body: JSON.stringify({ body, event, comments }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_labels",
        "List labels",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ owner, repo, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/labels${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_label",
        "Create label",
        { owner: z.string().min(1), repo: z.string().min(1), name: z.string().min(1), color: z.string().min(1), description: z.string().optional() },
        async ({ owner, repo, name, color, description }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/labels`, {
              method: "POST",
              body: JSON.stringify({ name, color, description }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_label",
        "Update label",
        { owner: z.string().min(1), repo: z.string().min(1), name: z.string().min(1), new_name: z.string().optional(), color: z.string().optional(), description: z.string().optional() },
        async ({ owner, repo, name, new_name, color, description }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, {
              method: "PATCH",
              body: JSON.stringify({ new_name, color, description }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_label",
        "Delete label",
        { owner: z.string().min(1), repo: z.string().min(1), name: z.string().min(1) },
        async ({ owner, repo, name }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_milestones",
        "List milestones",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          state: z.string().optional(),
          sort: z.string().optional(),
          direction: z.string().optional(),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ owner, repo, ...params }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/milestones${buildQuery(params)}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_milestone",
        "Create milestone",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          title: z.string().min(1),
          state: z.string().optional(),
          description: z.string().optional(),
          due_on: z.string().optional(),
        },
        async ({ owner, repo, title, state, description, due_on }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/milestones`, {
              method: "POST",
              body: JSON.stringify({ title, state, description, due_on }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_milestone",
        "Update milestone",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          milestone_number: z.number().int().min(1),
          title: z.string().optional(),
          state: z.string().optional(),
          description: z.string().optional(),
          due_on: z.string().optional(),
        },
        async ({ owner, repo, milestone_number, ...rest }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/milestones/${milestone_number}`, {
              method: "PATCH",
              body: JSON.stringify(rest),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_milestone",
        "Delete milestone",
        { owner: z.string().min(1), repo: z.string().min(1), milestone_number: z.number().int().min(1) },
        async ({ owner, repo, milestone_number }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/milestones/${milestone_number}`, { method: "DELETE" });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_orgs",
        "List user orgs",
        { per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() },
        async ({ per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/user/orgs${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_org",
        "Get organization",
        { org: z.string().min(1) },
        async ({ org }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/orgs/${org}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_org_members",
        "List org members",
        { org: z.string().min(1), per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() },
        async ({ org, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/orgs/${org}/members${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_teams",
        "List teams",
        { org: z.string().min(1), per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() },
        async ({ org, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/orgs/${org}/teams${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_team",
        "Get team",
        { org: z.string().min(1), team_slug: z.string().min(1) },
        async ({ org, team_slug }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/orgs/${org}/teams/${team_slug}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_team_members",
        "List team members",
        { org: z.string().min(1), team_slug: z.string().min(1), per_page: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() },
        async ({ org, team_slug, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/orgs/${org}/teams/${team_slug}/members${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_branches",
        "List branches",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          per_page: z.number().int().min(1).max(100).optional(),
          page: z.number().int().min(1).optional(),
        },
        async ({ owner, repo, per_page, page }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/branches${buildQuery({ per_page, page })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_branch",
        "Get branch",
        { owner: z.string().min(1), repo: z.string().min(1), branch: z.string().min(1) },
        async ({ owner, repo, branch }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_branch",
        "Delete branch",
        { owner: z.string().min(1), repo: z.string().min(1), branch: z.string().min(1) },
        async ({ owner, repo, branch }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
              method: "DELETE",
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_list_commits",
        "List commits",
        {
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
        async ({ owner, repo, ...params }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/commits${buildQuery(params)}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_commit",
        "Get commit",
        { owner: z.string().min(1), repo: z.string().min(1), ref: z.string().min(1) },
        async ({ owner, repo, ref }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/commits/${ref}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_get_file",
        "Get file contents",
        { owner: z.string().min(1), repo: z.string().min(1), path: z.string().min(1), ref: z.string().optional() },
        async ({ owner, repo, path, ref }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/contents/${path}${buildQuery({ ref })}`);
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_create_file",
        "Create file",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          path: z.string().min(1),
          message: z.string().min(1),
          content: z.string().min(1),
          branch: z.string().optional(),
          committer: z.record(z.any()).optional(),
          author: z.record(z.any()).optional(),
        },
        async ({ owner, repo, path, message, content, branch, committer, author }) => {
          try {
            const orgId = getOrgId();
            const encodedContent = Buffer.from(content).toString("base64");
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/contents/${path}`, {
              method: "PUT",
              body: JSON.stringify({ message, content: encodedContent, branch, committer, author }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_update_file",
        "Update file",
        {
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
        async ({ owner, repo, path, message, content, sha, branch, committer, author }) => {
          try {
            const orgId = getOrgId();
            const encodedContent = Buffer.from(content).toString("base64");
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/contents/${path}`, {
              method: "PUT",
              body: JSON.stringify({ message, content: encodedContent, sha, branch, committer, author }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "github_delete_file",
        "Delete file",
        {
          owner: z.string().min(1),
          repo: z.string().min(1),
          path: z.string().min(1),
          message: z.string().min(1),
          sha: z.string().min(1),
          branch: z.string().optional(),
          committer: z.record(z.any()).optional(),
          author: z.record(z.any()).optional(),
        },
        async ({ owner, repo, path, message, sha, branch, committer, author }) => {
          try {
            const orgId = getOrgId();
            const data = await githubFetch(orgId, `/repos/${owner}/${repo}/contents/${path}`, {
              method: "DELETE",
              body: JSON.stringify({ message, sha, branch, committer, author }),
            });
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );
    },
    { capabilities: { tools: {} } },
    { basePath: "/api/mcps/github", maxDuration: 60 },
  );

  return mcpHandler;
}

async function handleRequest(req: NextRequest): Promise<Response> {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);

    const rateLimitKey = `mcp:ratelimit:github:${authResult.user.organization_id}`;
    const rateLimit = await checkRateLimitRedis(rateLimitKey, 60000, 100);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    const handler = await getGitHubMcpHandler();
    const mcpResponse = await authContextStorage.run(authResult, () => handler(req as Request));

    if (!mcpResponse || !isMcpHandlerResponse(mcpResponse)) {
      return new Response(JSON.stringify({ error: "invalid_response" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const bodyText = mcpResponse.text ? await mcpResponse.text() : "";
    const headers: Record<string, string> = {};
    mcpResponse.headers?.forEach((v: string, k: string) => { headers[k] = v; });

    return new Response(bodyText, { status: mcpResponse.status, headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`[GitHubMCP] ${msg}`);
    const isAuth = msg.includes("API key") || msg.includes("auth") || msg.includes("Unauthorized");
    return new Response(JSON.stringify({ error: isAuth ? "authentication_required" : "internal_error", message: msg }), { status: isAuth ? 401 : 500, headers: { "Content-Type": "application/json" } });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
