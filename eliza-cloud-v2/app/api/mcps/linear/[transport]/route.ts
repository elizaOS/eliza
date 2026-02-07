/**
 * Linear MCP Server - Issues, Projects, Teams
 *
 * Standalone MCP endpoint for Linear tools with per-org OAuth.
 * Config: { "type": "streamable-http", "url": "/api/mcps/linear/streamable-http" }
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

async function getLinearMcpHandler() {
  if (mcpHandler) return mcpHandler;

  const { createMcpHandler } = await import("mcp-handler");
  const { z } = await import("zod3");

  async function getLinearToken(organizationId: string): Promise<string> {
    const result = await oauthService.getValidTokenByPlatform({ organizationId, platform: "linear" });
    return result.accessToken;
  }

  async function linearGraphQL(
    orgId: string,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    const token = await getLinearToken(orgId);
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.message || `Linear API error: ${response.status}`);
    }

    const text = await response.text();
    if (!text || !text.trim()) return undefined;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Linear API returned invalid JSON: ${text.slice(0, 200)}`);
    }
    if (data?.errors?.length) {
      throw new Error(data.errors.map((e: { message: string }) => e.message).join("; ") || "Linear API error");
    }
    return data?.data;
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

  mcpHandler = createMcpHandler(
    (server) => {
      server.tool("linear_status", "Check Linear OAuth connection status", {}, async () => {
        try {
          const orgId = getOrgId();
          const connections = await oauthService.listConnections({ organizationId: orgId, platform: "linear" });
          const active = connections.find((c) => c.status === "active");
          return jsonResult(active ? { connected: true, email: active.email, scopes: active.scopes } : { connected: false });
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : "Failed");
        }
      });

      server.tool(
        "linear_list_issues",
        "List or filter issues",
        {
          filter: z.record(z.any()).optional(),
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
          orderBy: z.string().optional(),
          includeArchived: z.boolean().optional(),
        },
        async ({ filter, first, after, orderBy, includeArchived }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Issues($filter: IssueFilter, $first: Int, $after: String, $orderBy: IssueOrderBy, $includeArchived: Boolean) {
                issues(filter: $filter, first: $first, after: $after, orderBy: $orderBy, includeArchived: $includeArchived) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    url
                    priority
                    createdAt
                    updatedAt
                    team { id name key }
                    assignee { id name email }
                    project { id name }
                    state { id name type }
                    labels { nodes { id name color } }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { filter, first, after, orderBy, includeArchived },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_get_issue",
        "Get issue by ID",
        { id: z.string().min(1).describe("Issue ID") },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Issue($id: String!) {
                issue(id: $id) {
                  id
                  identifier
                  title
                  description
                  url
                  priority
                  createdAt
                  updatedAt
                  team { id name key }
                  assignee { id name email }
                  project { id name }
                  state { id name type }
                  labels { nodes { id name color } }
                }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_create_issue",
        "Create issue",
        {
          teamId: z.string().min(1),
          title: z.string().min(1),
          description: z.string().optional(),
          assigneeId: z.string().optional(),
          projectId: z.string().optional(),
          stateId: z.string().optional(),
          priority: z.number().int().optional(),
          labelIds: z.array(z.string()).optional(),
          cycleId: z.string().optional(),
          dueDate: z.string().optional(),
          parentId: z.string().optional(),
        },
        async (input) => {
          try {
            const orgId = getOrgId();
            const { teamId, title, ...rest } = input;
            const issueInput: Record<string, unknown> = { teamId, title };
            Object.entries(rest).forEach(([key, value]) => {
              if (value !== undefined) issueInput[key] = value;
            });
            const data = await linearGraphQL(
              orgId,
              `mutation IssueCreate($input: IssueCreateInput!) {
                issueCreate(input: $input) {
                  success
                  issue { id identifier title url }
                }
              }`,
              { input: issueInput },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_update_issue",
        "Update issue",
        {
          id: z.string().min(1),
          title: z.string().optional(),
          description: z.string().optional(),
          assigneeId: z.string().optional(),
          projectId: z.string().optional(),
          stateId: z.string().optional(),
          priority: z.number().int().optional(),
          labelIds: z.array(z.string()).optional(),
          cycleId: z.string().optional(),
          dueDate: z.string().optional(),
          parentId: z.string().optional(),
        },
        async ({ id, ...rest }) => {
          try {
            const orgId = getOrgId();
            const input: Record<string, unknown> = {};
            Object.entries(rest).forEach(([key, value]) => {
              if (value !== undefined) input[key] = value;
            });
            const data = await linearGraphQL(
              orgId,
              `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
                issueUpdate(id: $id, input: $input) {
                  success
                  issue { id identifier title url }
                }
              }`,
              { id, input },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_archive_issue",
        "Archive issue",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation IssueArchive($id: String!) {
                issueArchive(id: $id) { success }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_delete_issue",
        "Delete issue",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation IssueDelete($id: String!) {
                issueDelete(id: $id) { success }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_comments",
        "List issue comments",
        {
          issueId: z.string().min(1),
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
        },
        async ({ issueId, first, after }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query IssueComments($issueId: String!, $first: Int, $after: String) {
                issue(id: $issueId) {
                  comments(first: $first, after: $after) {
                    nodes { id body createdAt updatedAt user { id name email } }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }`,
              { issueId, first, after },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_create_comment",
        "Create comment",
        { issueId: z.string().min(1), body: z.string().min(1) },
        async ({ issueId, body }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation CommentCreate($input: CommentCreateInput!) {
                commentCreate(input: $input) {
                  success
                  comment { id body createdAt updatedAt }
                }
              }`,
              { input: { issueId, body } },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_update_comment",
        "Update comment",
        { id: z.string().min(1), body: z.string().min(1) },
        async ({ id, body }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
                commentUpdate(id: $id, input: $input) {
                  success
                  comment { id body updatedAt }
                }
              }`,
              { id, input: { body } },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_delete_comment",
        "Delete comment",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation CommentDelete($id: String!) {
                commentDelete(id: $id) { success }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_teams",
        "List teams",
        { first: z.number().int().min(1).max(100).optional(), after: z.string().optional() },
        async ({ first, after }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Teams($first: Int, $after: String) {
                teams(first: $first, after: $after) {
                  nodes { id name key description }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { first, after },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_get_team",
        "Get team details",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Team($id: String!) {
                team(id: $id) { id name key description cyclesEnabled private }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_projects",
        "List projects",
        {
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
          filter: z.record(z.any()).optional(),
        },
        async ({ first, after, filter }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Projects($first: Int, $after: String, $filter: ProjectFilter) {
                projects(first: $first, after: $after, filter: $filter) {
                  nodes {
                    id
                    name
                    description
                    state
                    startDate
                    targetDate
                    lead { id name email }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { first, after, filter },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_get_project",
        "Get project",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Project($id: String!) {
                project(id: $id) {
                  id
                  name
                  description
                  state
                  startDate
                  targetDate
                  lead { id name email }
                }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_create_project",
        "Create project",
        {
          name: z.string().min(1),
          description: z.string().optional(),
          teamIds: z.array(z.string()).optional(),
          startDate: z.string().optional(),
          targetDate: z.string().optional(),
          state: z.string().optional(),
          leadId: z.string().optional(),
        },
        async (input) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation ProjectCreate($input: ProjectCreateInput!) {
                projectCreate(input: $input) {
                  success
                  project { id name }
                }
              }`,
              { input },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_update_project",
        "Update project",
        {
          id: z.string().min(1),
          name: z.string().optional(),
          description: z.string().optional(),
          teamIds: z.array(z.string()).optional(),
          startDate: z.string().optional(),
          targetDate: z.string().optional(),
          state: z.string().optional(),
          leadId: z.string().optional(),
        },
        async ({ id, ...rest }) => {
          try {
            const orgId = getOrgId();
            const input: Record<string, unknown> = {};
            Object.entries(rest).forEach(([key, value]) => {
              if (value !== undefined) input[key] = value;
            });
            const data = await linearGraphQL(
              orgId,
              `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
                projectUpdate(id: $id, input: $input) {
                  success
                  project { id name }
                }
              }`,
              { id, input },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_archive_project",
        "Archive project",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation ProjectArchive($id: String!) {
                projectArchive(id: $id) { success }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_labels",
        "List labels",
        {
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
          filter: z.record(z.any()).optional(),
        },
        async ({ first, after, filter }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Labels($first: Int, $after: String, $filter: IssueLabelFilter) {
                issueLabels(first: $first, after: $after, filter: $filter) {
                  nodes { id name color description }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { first, after, filter },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_create_label",
        "Create label",
        {
          name: z.string().min(1),
          teamId: z.string().min(1),
          color: z.string().optional(),
          description: z.string().optional(),
        },
        async ({ name, teamId, color, description }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation LabelCreate($input: IssueLabelCreateInput!) {
                issueLabelCreate(input: $input) {
                  success
                  issueLabel { id name color }
                }
              }`,
              { input: { name, teamId, color, description } },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_users",
        "List workspace users",
        { first: z.number().int().min(1).max(100).optional(), after: z.string().optional() },
        async ({ first, after }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Users($first: Int, $after: String) {
                users(first: $first, after: $after) {
                  nodes { id name email active }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { first, after },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool("linear_get_viewer", "Get current user", {}, async () => {
        try {
          const orgId = getOrgId();
          const data = await linearGraphQL(
            orgId,
            `query Viewer {
              viewer { id name email active }
            }`,
          );
          return jsonResult(data);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : "Failed");
        }
      });

      server.tool(
        "linear_list_cycles",
        "List cycles/sprints",
        {
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
          filter: z.record(z.any()).optional(),
        },
        async ({ first, after, filter }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Cycles($first: Int, $after: String, $filter: CycleFilter) {
                cycles(first: $first, after: $after, filter: $filter) {
                  nodes { id number startsAt endsAt team { id name key } }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { first, after, filter },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_get_cycle",
        "Get cycle details",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Cycle($id: String!) {
                cycle(id: $id) { id number startsAt endsAt team { id name key } }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_list_attachments",
        "List issue attachments",
        {
          issueId: z.string().min(1),
          first: z.number().int().min(1).max(100).optional(),
          after: z.string().optional(),
        },
        async ({ issueId, first, after }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `query Attachments($issueId: String!, $first: Int, $after: String) {
                issue(id: $issueId) {
                  attachments(first: $first, after: $after) {
                    nodes { id title url createdAt }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }`,
              { issueId, first, after },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_create_attachment",
        "Create attachment",
        { issueId: z.string().min(1), url: z.string().min(1), title: z.string().optional() },
        async ({ issueId, url, title }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation AttachmentCreate($input: AttachmentCreateInput!) {
                attachmentCreate(input: $input) {
                  success
                  attachment { id title url }
                }
              }`,
              { input: { issueId, url, title } },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );

      server.tool(
        "linear_delete_attachment",
        "Delete attachment",
        { id: z.string().min(1) },
        async ({ id }) => {
          try {
            const orgId = getOrgId();
            const data = await linearGraphQL(
              orgId,
              `mutation AttachmentDelete($id: String!) {
                attachmentDelete(id: $id) { success }
              }`,
              { id },
            );
            return jsonResult(data);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : "Failed");
          }
        },
      );
    },
    { capabilities: { tools: {} } },
    { basePath: "/api/mcps/linear", maxDuration: 60 },
  );

  return mcpHandler;
}

async function handleRequest(req: NextRequest): Promise<Response> {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);

    const rateLimitKey = `mcp:ratelimit:linear:${authResult.user.organization_id}`;
    const rateLimit = await checkRateLimitRedis(rateLimitKey, 60000, 100);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    const handler = await getLinearMcpHandler();
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
    logger.error(`[LinearMCP] ${msg}`);
    const isAuth = msg.includes("API key") || msg.includes("auth") || msg.includes("Unauthorized");
    return new Response(JSON.stringify({ error: isAuth ? "authentication_required" : "internal_error", message: msg }), { status: isAuth ? 401 : 500, headers: { "Content-Type": "application/json" } });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
