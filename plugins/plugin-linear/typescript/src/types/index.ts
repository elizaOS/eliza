export interface LinearConfig {
  LINEAR_API_KEY: string;
  LINEAR_WORKSPACE_ID?: string;
}

export interface LinearActivityItem {
  id: string;
  timestamp: string;
  action: string;
  resource_type: "issue" | "project" | "comment" | "label" | "user" | "team";
  resource_id: string;
  details: Record<string, unknown>;
  success: boolean;
  error?: string;
}

export interface LinearIssueInput {
  title: string;
  description?: string;
  teamId: string;
  priority?: number; // 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low
  assigneeId?: string;
  labelIds?: string[];
  projectId?: string;
  stateId?: string;
  estimate?: number;
  dueDate?: Date;
}

export interface LinearCommentInput {
  body: string;
  issueId: string;
}

export interface LinearSearchFilters {
  state?: string[];
  assignee?: string[];
  label?: string[];
  project?: string;
  team?: string;
  priority?: number[];
  query?: string;
  limit?: number;
}

/**
 * Action-specific parameter types for type-safe handler options
 */

/** Parameters for CREATE_LINEAR_COMMENT action */
export interface CreateCommentParameters {
  issueId?: string;
  body?: string;
}

/** Parameters for CREATE_LINEAR_ISSUE action */
export interface CreateIssueParameters {
  issueData?: Partial<LinearIssueInput>;
}

/** Parameters for DELETE_LINEAR_ISSUE action */
export interface DeleteIssueParameters {
  issueId?: string;
}

/** Parameters for SEARCH_LINEAR_ISSUES action */
export interface SearchIssuesParameters {
  filters?: LinearSearchFilters;
  limit?: number;
}

/** Type guard to check if parameters match CreateCommentParameters */
export function isCreateCommentParameters(
  params: Record<string, unknown> | undefined
): params is CreateCommentParameters {
  if (!params) return false;
  return (
    (params.issueId === undefined || typeof params.issueId === "string") &&
    (params.body === undefined || typeof params.body === "string")
  );
}

/** Type guard to check if parameters match CreateIssueParameters */
export function isCreateIssueParameters(
  params: Record<string, unknown> | undefined
): params is CreateIssueParameters {
  if (!params) return false;
  return params.issueData === undefined || typeof params.issueData === "object";
}

/** Type guard to check if parameters match DeleteIssueParameters */
export function isDeleteIssueParameters(
  params: Record<string, unknown> | undefined
): params is DeleteIssueParameters {
  if (!params) return false;
  return params.issueId === undefined || typeof params.issueId === "string";
}

/** Type guard to check if parameters match SearchIssuesParameters */
export function isSearchIssuesParameters(
  params: Record<string, unknown> | undefined
): params is SearchIssuesParameters {
  if (!params) return false;
  return (
    (params.filters === undefined || typeof params.filters === "object") &&
    (params.limit === undefined || typeof params.limit === "number")
  );
}

/** Error response structure from Linear API */
export interface LinearErrorResponse {
  message?: string;
  errors?: Array<{ message: string; path?: string[] }>;
}

// Error classes specific to Linear
export class LinearAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: LinearErrorResponse
  ) {
    super(message);
    this.name = "LinearAPIError";
  }
}

export class LinearAuthenticationError extends LinearAPIError {
  constructor(message: string) {
    super(message, 401);
    this.name = "LinearAuthenticationError";
  }
}

export class LinearRateLimitError extends LinearAPIError {
  constructor(
    message: string,
    public resetTime: number
  ) {
    super(message, 429);
    this.name = "LinearRateLimitError";
  }
}
