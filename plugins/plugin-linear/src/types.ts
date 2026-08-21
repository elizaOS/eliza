/**
 * Validated public DTOs for the read-only Linear surface plus the schemas the
 * client uses to reject untrusted GraphQL response payloads. Workflow state
 * types mirror Linear's fixed state-machine categories; any other value is
 * treated as schema drift, never coerced.
 */

import { z } from "zod";

export const linearWorkflowStateTypes = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;
export type LinearWorkflowStateType = (typeof linearWorkflowStateTypes)[number];

const nonEmpty = z.string().min(1).max(2_048);

export const linearTeamSchema = z.object({
  id: nonEmpty,
  key: z.string().min(1).max(64),
  name: nonEmpty,
});
export type LinearTeam = z.infer<typeof linearTeamSchema>;

export const linearUserSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
});
export type LinearUser = z.infer<typeof linearUserSchema>;

export const linearIssueSchema = z.object({
  id: nonEmpty,
  identifier: z.string().min(1).max(64),
  title: z.string().min(1).max(4_096),
  url: z.url().startsWith("https://"),
  priority: z.number().int().min(0).max(4),
  updatedAt: z.iso.datetime(),
  state: z.object({
    name: nonEmpty,
    type: z.enum(linearWorkflowStateTypes),
  }),
  team: linearTeamSchema,
  assignee: linearUserSchema.nullable(),
});
export type LinearIssue = z.infer<typeof linearIssueSchema>;

export const linearPageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).max(2_048).nullable(),
});

export const linearIssuePageSchema = z.object({
  issues: z.array(linearIssueSchema).max(250),
  nextCursor: z.string().min(1).max(2_048).nullable(),
});
export type LinearIssuePage = z.infer<typeof linearIssuePageSchema>;

export const linearTeamPageSchema = z.object({
  teams: z.array(linearTeamSchema).max(250),
  nextCursor: z.string().min(1).max(2_048).nullable(),
});
export type LinearTeamPage = z.infer<typeof linearTeamPageSchema>;

export const linearViewerSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
});
export type LinearViewer = z.infer<typeof linearViewerSchema>;

export const issueSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  teamKey: z.string().trim().min(1).max(64).optional(),
  stateType: z.enum(linearWorkflowStateTypes).optional(),
  assignedToMe: z.boolean().optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type IssueSearchRequest = z.infer<typeof issueSearchRequestSchema>;

export const teamListRequestSchema = z.object({
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type TeamListRequest = z.infer<typeof teamListRequestSchema>;

/** GraphQL transport envelope; `data` stays untyped until operation schemas run. */
export const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().max(4_096).optional(),
        extensions: z
          .object({ code: z.string().max(256).optional() })
          .loose()
          .optional(),
      }),
    )
    .optional(),
});
export type GraphqlEnvelope = z.infer<typeof graphqlEnvelopeSchema>;

export const issuesQueryDataSchema = z.object({
  issues: z.object({
    nodes: z.array(linearIssueSchema).max(250),
    pageInfo: linearPageInfoSchema,
  }),
});

export const issueQueryDataSchema = z.object({
  issue: linearIssueSchema.nullable(),
});

export const teamsQueryDataSchema = z.object({
  teams: z.object({
    nodes: z.array(linearTeamSchema).max(250),
    pageInfo: linearPageInfoSchema,
  }),
});

export const viewerQueryDataSchema = z.object({
  viewer: linearViewerSchema,
});
