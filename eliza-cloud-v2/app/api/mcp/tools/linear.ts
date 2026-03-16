/**
 * Linear MCP Tools - Issues, Projects, Teams
 * Uses per-organization OAuth tokens via oauthService.
 */

import type { McpServer } from "mcp-handler";
import { z } from "zod3";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

async function getLinearToken(): Promise<string> {
  const { user } = getAuthContext();
  try {
    const result = await oauthService.getValidTokenByPlatform({
      organizationId: user.organization_id,
      platform: "linear",
    });
    return result.accessToken;
  } catch (error) {
    logger.warn("[LinearMCP] Failed to get token", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Linear account not connected. Connect in Settings > Connections.");
  }
}

async function linearGraphQL(query: string, variables?: Record<string, unknown>) {
  const token = await getLinearToken();
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

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function registerLinearTools(server: McpServer): void {
  server.registerTool(
    "linear_status",
    {
      description: "Check Linear OAuth connection status",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const connections = await oauthService.listConnections({
          organizationId: user.organization_id,
          platform: "linear",
        });
        const active = connections.find((c) => c.status === "active");
        if (!active) {
          return jsonResponse({
            connected: false,
            message: "Linear not connected. Connect in Settings > Connections.",
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
    "linear_list_issues",
    {
      description: "List or filter issues",
      inputSchema: {
        filter: z.record(z.any()).optional(),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        orderBy: z.string().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ filter, first, after, orderBy, includeArchived }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list issues"));
      }
    },
  );

  server.registerTool(
    "linear_get_issue",
    {
      description: "Get issue by ID",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get issue"));
      }
    },
  );

  server.registerTool(
    "linear_create_issue",
    {
      description: "Create issue",
      inputSchema: {
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
    },
    async (input) => {
      try {
        const { teamId, title, ...rest } = input;
        const issueInput: Record<string, unknown> = { teamId, title };
        Object.entries(rest).forEach(([key, value]) => {
          if (value !== undefined) issueInput[key] = value;
        });
        const data = await linearGraphQL(
          `mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier title url }
            }
          }`,
          { input: issueInput },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create issue"));
      }
    },
  );

  server.registerTool(
    "linear_update_issue",
    {
      description: "Update issue",
      inputSchema: {
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
    },
    async ({ id, ...rest }) => {
      try {
        const input: Record<string, unknown> = {};
        Object.entries(rest).forEach(([key, value]) => {
          if (value !== undefined) input[key] = value;
        });
        const data = await linearGraphQL(
          `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue { id identifier title url }
            }
          }`,
          { id, input },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update issue"));
      }
    },
  );

  server.registerTool(
    "linear_archive_issue",
    {
      description: "Archive issue",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `mutation IssueArchive($id: String!) {
            issueArchive(id: $id) { success }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to archive issue"));
      }
    },
  );

  server.registerTool(
    "linear_delete_issue",
    {
      description: "Delete issue",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `mutation IssueDelete($id: String!) {
            issueDelete(id: $id) { success }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete issue"));
      }
    },
  );

  server.registerTool(
    "linear_list_comments",
    {
      description: "List issue comments",
      inputSchema: {
        issueId: z.string().min(1),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
      },
    },
    async ({ issueId, first, after }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list comments"));
      }
    },
  );

  server.registerTool(
    "linear_create_comment",
    {
      description: "Create comment",
      inputSchema: {
        issueId: z.string().min(1),
        body: z.string().min(1),
      },
    },
    async ({ issueId, body }) => {
      try {
        const data = await linearGraphQL(
          `mutation CommentCreate($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment { id body createdAt updatedAt }
            }
          }`,
          { input: { issueId, body } },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create comment"));
      }
    },
  );

  server.registerTool(
    "linear_update_comment",
    {
      description: "Update comment",
      inputSchema: {
        id: z.string().min(1),
        body: z.string().min(1),
      },
    },
    async ({ id, body }) => {
      try {
        const data = await linearGraphQL(
          `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
            commentUpdate(id: $id, input: $input) {
              success
              comment { id body updatedAt }
            }
          }`,
          { id, input: { body } },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update comment"));
      }
    },
  );

  server.registerTool(
    "linear_delete_comment",
    {
      description: "Delete comment",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `mutation CommentDelete($id: String!) {
            commentDelete(id: $id) { success }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete comment"));
      }
    },
  );

  server.registerTool(
    "linear_list_teams",
    {
      description: "List teams",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
      },
    },
    async ({ first, after }) => {
      try {
        const data = await linearGraphQL(
          `query Teams($first: Int, $after: String) {
            teams(first: $first, after: $after) {
              nodes { id name key description }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, after },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list teams"));
      }
    },
  );

  server.registerTool(
    "linear_get_team",
    {
      description: "Get team details",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `query Team($id: String!) {
            team(id: $id) { id name key description cyclesEnabled private }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get team"));
      }
    },
  );

  server.registerTool(
    "linear_list_projects",
    {
      description: "List projects",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        filter: z.record(z.any()).optional(),
      },
    },
    async ({ first, after, filter }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list projects"));
      }
    },
  );

  server.registerTool(
    "linear_get_project",
    {
      description: "Get project",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get project"));
      }
    },
  );

  server.registerTool(
    "linear_create_project",
    {
      description: "Create project",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        teamIds: z.array(z.string()).optional(),
        startDate: z.string().optional(),
        targetDate: z.string().optional(),
        state: z.string().optional(),
        leadId: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const data = await linearGraphQL(
          `mutation ProjectCreate($input: ProjectCreateInput!) {
            projectCreate(input: $input) {
              success
              project { id name }
            }
          }`,
          { input },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create project"));
      }
    },
  );

  server.registerTool(
    "linear_update_project",
    {
      description: "Update project",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        teamIds: z.array(z.string()).optional(),
        startDate: z.string().optional(),
        targetDate: z.string().optional(),
        state: z.string().optional(),
        leadId: z.string().optional(),
      },
    },
    async ({ id, ...rest }) => {
      try {
        const input: Record<string, unknown> = {};
        Object.entries(rest).forEach(([key, value]) => {
          if (value !== undefined) input[key] = value;
        });
        const data = await linearGraphQL(
          `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
            projectUpdate(id: $id, input: $input) {
              success
              project { id name }
            }
          }`,
          { id, input },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update project"));
      }
    },
  );

  server.registerTool(
    "linear_archive_project",
    {
      description: "Archive project",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `mutation ProjectArchive($id: String!) {
            projectArchive(id: $id) { success }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to archive project"));
      }
    },
  );

  server.registerTool(
    "linear_list_labels",
    {
      description: "List labels",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        filter: z.record(z.any()).optional(),
      },
    },
    async ({ first, after, filter }) => {
      try {
        const data = await linearGraphQL(
          `query Labels($first: Int, $after: String, $filter: IssueLabelFilter) {
            issueLabels(first: $first, after: $after, filter: $filter) {
              nodes { id name color description }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, after, filter },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list labels"));
      }
    },
  );

  server.registerTool(
    "linear_create_label",
    {
      description: "Create label",
      inputSchema: {
        name: z.string().min(1),
        teamId: z.string().min(1),
        color: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ name, teamId, color, description }) => {
      try {
        const data = await linearGraphQL(
          `mutation LabelCreate($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success
              issueLabel { id name color }
            }
          }`,
          { input: { name, teamId, color, description } },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create label"));
      }
    },
  );

  server.registerTool(
    "linear_list_users",
    {
      description: "List workspace users",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
      },
    },
    async ({ first, after }) => {
      try {
        const data = await linearGraphQL(
          `query Users($first: Int, $after: String) {
            users(first: $first, after: $after) {
              nodes { id name email active }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, after },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list users"));
      }
    },
  );

  server.registerTool(
    "linear_get_viewer",
    {
      description: "Get current user",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await linearGraphQL(
          `query Viewer {
            viewer { id name email active }
          }`,
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get viewer"));
      }
    },
  );

  server.registerTool(
    "linear_list_cycles",
    {
      description: "List cycles/sprints",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        filter: z.record(z.any()).optional(),
      },
    },
    async ({ first, after, filter }) => {
      try {
        const data = await linearGraphQL(
          `query Cycles($first: Int, $after: String, $filter: CycleFilter) {
            cycles(first: $first, after: $after, filter: $filter) {
              nodes { id number startsAt endsAt team { id name key } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, after, filter },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list cycles"));
      }
    },
  );

  server.registerTool(
    "linear_get_cycle",
    {
      description: "Get cycle details",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `query Cycle($id: String!) {
            cycle(id: $id) { id number startsAt endsAt team { id name key } }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to get cycle"));
      }
    },
  );

  server.registerTool(
    "linear_list_attachments",
    {
      description: "List issue attachments",
      inputSchema: {
        issueId: z.string().min(1),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
      },
    },
    async ({ issueId, first, after }) => {
      try {
        const data = await linearGraphQL(
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
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list attachments"));
      }
    },
  );

  server.registerTool(
    "linear_create_attachment",
    {
      description: "Create attachment",
      inputSchema: {
        issueId: z.string().min(1),
        url: z.string().min(1),
        title: z.string().optional(),
      },
    },
    async ({ issueId, url, title }) => {
      try {
        const data = await linearGraphQL(
          `mutation AttachmentCreate($input: AttachmentCreateInput!) {
            attachmentCreate(input: $input) {
              success
              attachment { id title url }
            }
          }`,
          { input: { issueId, url, title } },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create attachment"));
      }
    },
  );

  server.registerTool(
    "linear_delete_attachment",
    {
      description: "Delete attachment",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const data = await linearGraphQL(
          `mutation AttachmentDelete($id: String!) {
            attachmentDelete(id: $id) { success }
          }`,
          { id },
        );
        return jsonResponse(data);
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete attachment"));
      }
    },
  );
}
