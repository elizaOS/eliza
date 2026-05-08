import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type Comment,
  type Issue,
  type IssueLabel,
  LinearClient,
  type Project,
  type Team,
  type User,
  type WorkflowState,
} from "@linear/sdk";
import {
  DEFAULT_LINEAR_ACCOUNT_ID,
  normalizeLinearAccountId,
  readLinearAccounts,
  resolveLinearAccount,
  type LinearAccountConfig,
} from "../accounts";
import type {
  ActivityDetailObject,
  ActivityDetailValue,
  LinearActivityItem,
  LinearCommentInput,
  LinearConfig,
  LinearIssueInput,
  LinearSearchFilters,
} from "../types";
import { LinearAuthenticationError } from "../types";

interface LinearClientState {
  accountId: string;
  config: LinearAccountConfig;
  client: LinearClient;
}

export class LinearService extends Service {
  static serviceType = "linear";

  capabilityDescription =
    "Linear API integration for issue tracking, project management, and team collaboration";

  private clients = new Map<string, LinearClientState>();
  private activityLog: LinearActivityItem[] = [];
  private linearConfig: LinearConfig;
  private defaultAccountId = DEFAULT_LINEAR_ACCOUNT_ID;
  public workspaceId?: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    const accounts = runtime ? readLinearAccounts(runtime) : [];
    const requestedDefault = runtime
      ? normalizeLinearAccountId(
          runtime.getSetting("LINEAR_DEFAULT_ACCOUNT_ID") ??
            runtime.getSetting("LINEAR_ACCOUNT_ID")
        )
      : DEFAULT_LINEAR_ACCOUNT_ID;
    const defaultAccount =
      resolveLinearAccount(accounts, requestedDefault) ?? accounts[0] ?? null;

    if (!defaultAccount) {
      throw new LinearAuthenticationError("Linear API key is required");
    }

    this.linearConfig = {
      LINEAR_API_KEY: defaultAccount.apiKey,
      LINEAR_WORKSPACE_ID: defaultAccount.workspaceId,
      LINEAR_ACCOUNT_ID: defaultAccount.accountId,
      LINEAR_DEFAULT_ACCOUNT_ID: requestedDefault,
    };

    this.defaultAccountId = defaultAccount.accountId;
    this.workspaceId = defaultAccount.workspaceId;

    for (const account of accounts) {
      this.clients.set(account.accountId, {
        accountId: account.accountId,
        config: account,
        client: new LinearClient({ apiKey: account.apiKey }),
      });
    }
  }

  static async start(runtime: IAgentRuntime): Promise<LinearService> {
    const service = new LinearService(runtime);
    await service.validateConnection();
    logger.info("Linear service started successfully");
    return service;
  }

  async stop(): Promise<void> {
    this.activityLog = [];
    logger.info("Linear service stopped");
  }

  private async validateConnection(accountId?: string): Promise<void> {
    try {
      const state = this.getAccountState(accountId);
      const viewer = await state.client.viewer;
      logger.info(`Linear connected as user: ${viewer.email} (accountId=${state.accountId})`);
    } catch (_error) {
      throw new LinearAuthenticationError("Failed to authenticate with Linear API");
    }
  }

  hasAccount(accountId?: string): boolean {
    const normalized = normalizeLinearAccountId(accountId);
    return Boolean(
      this.clients.get(normalized) ??
        this.clients.get(this.defaultAccountId) ??
        Array.from(this.clients.values())[0]
    );
  }

  getDefaultTeamKey(accountId?: string): string | undefined {
    return this.getAccountState(accountId).config.defaultTeamKey;
  }

  private getAccountState(accountId?: string): LinearClientState {
    const normalized = normalizeLinearAccountId(accountId);
    const state =
      this.clients.get(normalized) ??
      this.clients.get(this.defaultAccountId) ??
      Array.from(this.clients.values())[0];
    if (!state) {
      throw new LinearAuthenticationError("Linear API key is required");
    }
    return state;
  }

  private getClient(accountId?: string): LinearClient {
    return this.getAccountState(accountId).client;
  }

  private logActivity(
    action: string,
    resourceType: LinearActivityItem["resource_type"],
    resourceId: string,
    details: Record<string, ActivityDetailValue>,
    success: boolean,
    error?: string
  ): void {
    const activity: LinearActivityItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details,
      success,
      error,
    };

    this.activityLog.push(activity);

    if (this.activityLog.length > 1000) {
      this.activityLog = this.activityLog.slice(-1000);
    }
  }

  getActivityLog(
    limit?: number,
    filter?: Partial<LinearActivityItem>,
    accountId?: string
  ): LinearActivityItem[] {
    let filtered = [...this.activityLog];

    if (filter) {
      filtered = filtered.filter((item) => {
        return Object.entries(filter).every(([key, value]) => {
          return item[key as keyof LinearActivityItem] === value;
        });
      });
    }
    if (accountId) {
      filtered = filtered.filter((item) => item.details.accountId === accountId);
    }

    return filtered.slice(-(limit || 100));
  }

  clearActivityLog(accountId?: string): void {
    if (accountId) {
      this.activityLog = this.activityLog.filter((item) => item.details.accountId !== accountId);
      logger.info(`Linear activity log cleared for accountId=${accountId}`);
      return;
    }
    this.activityLog = [];
    logger.info("Linear activity log cleared");
  }

  async getTeams(accountId?: string): Promise<Team[]> {
    const state = this.getAccountState(accountId);
    const teams = await state.client.teams();
    const teamList = await teams.nodes;

    this.logActivity(
      "list_teams",
      "team",
      "all",
      { count: teamList.length, accountId: state.accountId },
      true
    );
    return teamList;
  }

  async getTeam(teamId: string, accountId?: string): Promise<Team> {
    const state = this.getAccountState(accountId);
    const team = await state.client.team(teamId);
    this.logActivity(
      "get_team",
      "team",
      teamId,
      { name: team.name, accountId: state.accountId },
      true
    );
    return team;
  }

  async createIssue(input: LinearIssueInput, accountId?: string): Promise<Issue> {
    const state = this.getAccountState(accountId);
    const issuePayload = await state.client.createIssue({
      title: input.title,
      description: input.description,
      teamId: input.teamId,
      priority: input.priority,
      assigneeId: input.assigneeId,
      labelIds: input.labelIds,
      projectId: input.projectId,
      stateId: input.stateId,
      estimate: input.estimate,
      dueDate: input.dueDate,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error("Failed to create issue");
    }

    this.logActivity(
      "create_issue",
      "issue",
      issue.id,
      {
        title: input.title,
        teamId: input.teamId,
        accountId: state.accountId,
      },
      true
    );

    return issue;
  }

  async getIssue(issueId: string, accountId?: string): Promise<Issue> {
    const state = this.getAccountState(accountId);
    const issue = await state.client.issue(issueId);
    this.logActivity(
      "get_issue",
      "issue",
      issueId,
      {
        title: issue.title,
        identifier: issue.identifier,
        accountId: state.accountId,
      },
      true
    );
    return issue;
  }

  async updateIssue(
    issueId: string,
    updates: Partial<LinearIssueInput>,
    accountId?: string
  ): Promise<Issue> {
    const state = this.getAccountState(accountId);
    const updatePayload = await state.client.updateIssue(issueId, {
      title: updates.title,
      description: updates.description,
      priority: updates.priority,
      assigneeId: updates.assigneeId,
      labelIds: updates.labelIds,
      projectId: updates.projectId,
      stateId: updates.stateId,
      estimate: updates.estimate,
      dueDate: updates.dueDate,
    });

    const issue = await updatePayload.issue;
    if (!issue) {
      throw new Error("Failed to update issue");
    }

    this.logActivity(
      "update_issue",
      "issue",
      issueId,
      { ...updates, accountId: state.accountId },
      true
    );
    return issue;
  }

  async deleteIssue(issueId: string, accountId?: string): Promise<void> {
    const state = this.getAccountState(accountId);
    const archivePayload = await state.client.archiveIssue(issueId);

    const success = await archivePayload.success;
    if (!success) {
      throw new Error("Failed to archive issue");
    }

    this.logActivity(
      "delete_issue",
      "issue",
      issueId,
      { action: "archived", accountId: state.accountId },
      true
    );
  }

  async searchIssues(filters: LinearSearchFilters, accountId?: string): Promise<Issue[]> {
    const state = this.getAccountState(accountId);
    const filterObject: Record<string, string | number | boolean | object | null | undefined> = {};

    if (filters.query) {
      filterObject.or = [
        { title: { containsIgnoreCase: filters.query } },
        { description: { containsIgnoreCase: filters.query } },
      ];
    }

    if (filters.team) {
      const teams = await this.getTeams(state.accountId);
      const team = teams.find(
        (t) =>
          t.key.toLowerCase() === filters.team?.toLowerCase() ||
          t.name.toLowerCase() === filters.team?.toLowerCase()
      );

      if (team) {
        filterObject.team = { id: { eq: team.id } };
      }
    }

    if (filters.assignee && filters.assignee.length > 0) {
      const users = await this.getUsers(state.accountId);
      const assigneeIds = filters.assignee
        .map((assigneeName) => {
          const user = users.find(
            (u) =>
              u.email === assigneeName || u.name.toLowerCase().includes(assigneeName.toLowerCase())
          );
          return user?.id;
        })
        .filter(Boolean);

      if (assigneeIds.length > 0) {
        filterObject.assignee = { id: { in: assigneeIds } };
      }
    }

    if (filters.priority && filters.priority.length > 0) {
      filterObject.priority = { number: { in: filters.priority } };
    }

    // Add state filter
    if (filters.state && filters.state.length > 0) {
      filterObject.state = {
        name: { in: filters.state },
      };
    }

    if (filters.label && filters.label.length > 0) {
      filterObject.labels = {
        some: {
          name: { in: filters.label },
        },
      };
    }

    const query = state.client.issues({
      first: filters.limit || 50,
      filter: Object.keys(filterObject).length > 0 ? filterObject : undefined,
    });

    const issues = await query;
    const issueList = await issues.nodes;

    this.logActivity(
      "search_issues",
      "issue",
      "search",
      {
        filters: { ...filters, accountId: state.accountId } as ActivityDetailObject,
        count: issueList.length,
      },
      true
    );

    return issueList;
  }

  async createComment(input: LinearCommentInput, accountId?: string): Promise<Comment> {
    const state = this.getAccountState(accountId);
    const commentPayload = await state.client.createComment({
      body: input.body,
      issueId: input.issueId,
    });

    const comment = await commentPayload.comment;
    if (!comment) {
      throw new Error("Failed to create comment");
    }

    this.logActivity(
      "create_comment",
      "comment",
      comment.id,
      {
        issueId: input.issueId,
        bodyLength: input.body.length,
        accountId: state.accountId,
      },
      true
    );

    return comment;
  }

  async updateComment(commentId: string, body: string, accountId?: string): Promise<Comment> {
    const state = this.getAccountState(accountId);
    const commentPayload = await state.client.updateComment(commentId, {
      body,
    });
    const comment = await commentPayload.comment;
    if (!comment) {
      throw new Error("Failed to update comment");
    }
    this.logActivity(
      "update_comment",
      "comment",
      commentId,
      { bodyLength: body.length, accountId: state.accountId },
      true
    );
    return comment;
  }

  async deleteComment(commentId: string, accountId?: string): Promise<void> {
    const state = this.getAccountState(accountId);
    const payload = await state.client.deleteComment(commentId);
    if (!payload.success) {
      throw new Error("Failed to delete comment");
    }
    this.logActivity(
      "delete_comment",
      "comment",
      commentId,
      { accountId: state.accountId },
      true
    );
  }

  async listComments(issueId: string, limit = 25, accountId?: string): Promise<Comment[]> {
    const issue = await this.getClient(accountId).issue(issueId);
    const connection = await issue.comments({ first: Math.min(limit, 100) });
    return connection.nodes;
  }

  async getProjects(teamId?: string, accountId?: string): Promise<Project[]> {
    const state = this.getAccountState(accountId);
    // Linear SDK v51 requires manual team filtering on projects
    const query = state.client.projects({
      first: 100,
    });

    const projects = await query;
    let projectList = await projects.nodes;

    if (teamId) {
      const filteredProjects = await Promise.all(
        projectList.map(async (project) => {
          const projectTeams = await project.teams();
          const teamsList = await projectTeams.nodes;
          const hasTeam = teamsList.some((team: Team) => team.id === teamId);
          return hasTeam ? project : null;
        })
      );
      projectList = filteredProjects.filter(Boolean) as Project[];
    }

    this.logActivity(
      "list_projects",
      "project",
      "all",
      {
        count: projectList.length,
        teamId,
        accountId: state.accountId,
      },
      true
    );

    return projectList;
  }

  async getProject(projectId: string, accountId?: string): Promise<Project> {
    const state = this.getAccountState(accountId);
    const project = await state.client.project(projectId);
    this.logActivity(
      "get_project",
      "project",
      projectId,
      {
        name: project.name,
        accountId: state.accountId,
      },
      true
    );
    return project;
  }

  async getUsers(accountId?: string): Promise<User[]> {
    const state = this.getAccountState(accountId);
    const users = await state.client.users();
    const userList = await users.nodes;

    this.logActivity(
      "list_users",
      "user",
      "all",
      {
        count: userList.length,
        accountId: state.accountId,
      },
      true
    );

    return userList;
  }

  async getCurrentUser(accountId?: string): Promise<User> {
    const state = this.getAccountState(accountId);
    const user = await state.client.viewer;
    this.logActivity(
      "get_current_user",
      "user",
      user.id,
      {
        email: user.email,
        name: user.name,
        accountId: state.accountId,
      },
      true
    );
    return user;
  }

  async getUserTeams(accountId?: string): Promise<Team[]> {
    const state = this.getAccountState(accountId);
    const viewer = await state.client.viewer;
    const teams = await viewer.teams();
    const teamList = await teams.nodes;

    this.logActivity(
      "list_user_teams",
      "team",
      viewer.id,
      {
        count: teamList.length,
        accountId: state.accountId,
      },
      true
    );

    return teamList;
  }

  async getLabels(teamId?: string, accountId?: string): Promise<IssueLabel[]> {
    const state = this.getAccountState(accountId);
    const query = state.client.issueLabels({
      first: 100,
      filter: teamId
        ? {
            team: { id: { eq: teamId } },
          }
        : undefined,
    });

    const labels = await query;
    const labelList = await labels.nodes;

    this.logActivity(
      "list_labels",
      "label",
      "all",
      {
        count: labelList.length,
        teamId,
        accountId: state.accountId,
      },
      true
    );

    return labelList;
  }

  async getWorkflowStates(teamId: string, accountId?: string): Promise<WorkflowState[]> {
    const state = this.getAccountState(accountId);
    const states = await state.client.workflowStates({
      filter: {
        team: { id: { eq: teamId } },
      },
    });

    const stateList = await states.nodes;

    this.logActivity(
      "list_workflow_states",
      "team",
      teamId,
      {
        count: stateList.length,
        accountId: state.accountId,
      },
      true
    );

    return stateList;
  }
}
