export interface LinearConfig {
  LINEAR_API_KEY: string;
  LINEAR_WORKSPACE_ID?: string;
}

export interface LinearActivityItem {
  id: string;
  timestamp: string;
  action: string;
  resource_type: 'issue' | 'project' | 'comment' | 'label' | 'user' | 'team';
  resource_id: string;
  details: Record<string, any>;
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

// Error classes specific to Linear
export class LinearAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'LinearAPIError';
  }
}

export class LinearAuthenticationError extends LinearAPIError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'LinearAuthenticationError';
  }
}

export class LinearRateLimitError extends LinearAPIError {
  constructor(
    message: string,
    public resetTime: number
  ) {
    super(message, 429);
    this.name = 'LinearRateLimitError';
  }
} 