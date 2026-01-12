export interface LinearConfig {
  LINEAR_API_KEY: string;
  LINEAR_WORKSPACE_ID?: string;
}

/** Primitive types allowed in activity details */
export type ActivityDetailPrimitive = string | number | boolean | null;

/** Array types allowed in activity details */
export type ActivityDetailArray = ActivityDetailPrimitive[];

/** Nested object allowed in activity details (one level deep) */
export type ActivityDetailObject = Record<string, ActivityDetailPrimitive | ActivityDetailArray>;

/** Valid values for activity detail fields */
export type ActivityDetailValue =
  | ActivityDetailPrimitive
  | ActivityDetailArray
  | ActivityDetailObject
  | Date;

export interface LinearActivityItem {
  id: string;
  timestamp: string;
  action: string;
  resource_type: "issue" | "project" | "comment" | "label" | "user" | "team";
  resource_id: string;
  details: Record<string, ActivityDetailValue>;
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

export interface CreateCommentParameters {
  issueId?: string;
  body?: string;
}

export interface CreateIssueParameters {
  issueData?: Partial<LinearIssueInput>;
}

export interface DeleteIssueParameters {
  issueId?: string;
}

export interface SearchIssuesParameters {
  filters?: LinearSearchFilters;
  limit?: number;
}

export interface LinearErrorResponse {
  message?: string;
  errors?: Array<{ message: string; path?: string[] }>;
}
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
