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

export class LinearService extends Service {
  static serviceType = "linear";

  capabilityDescription =
    "Linear API integration for issue tracking, project management, and team collaboration";

  private client: LinearClient;
  private activityLog: LinearActivityItem[] = [];
  private linearConfig: LinearConfig;
  public workspaceId?: string;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    const apiKey = runtime?.getSetting("LINEAR_API_KEY") as string;
    const workspaceId = runtime?.getSetting("LINEAR_WORKSPACE_ID") as string;

    if (!apiKey) {
      throw new LinearAuthenticationError("Linear API key is required");
    }

    this.linearConfig = {
      LINEAR_API_KEY: apiKey,
      LINEAR_WORKSPACE_ID: workspaceId,
    };

    this.workspaceId = workspaceId;

    this.client = new LinearClient({
      apiKey: this.linearConfig.LINEAR_API_KEY,
    });
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

  private async validateConnection(): Promise<void> {
    try {
      const viewer = await this.client.viewer;
      logger.info(`Linear connected as user: ${viewer.email}`);
    } catch (_error) {
      throw new LinearAuthenticationError("Failed to authenticate with Linear API");
    }
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

  getActivityLog(limit?: number, filter?: Partial<LinearActivityItem>): LinearActivityItem[] {
    let filtered = [...this.activityLog];

    if (filter) {
      filtered = filtered.filter((item) => {
        return Object.entries(filter).every(([key, value]) => {
          return item[key as keyof LinearActivityItem] === value;
        });
      });
    }

    return filtered.slice(-(limit || 100));
  }

  clearActivityLog(): void {
    this.activityLog = [];
    logger.info("Linear activity log cleared");
  }

  async getTeams(): Promise<Team[]> {
    const teams = await this.client.teams();
    const teamList = await teams.nodes;

    this.logActivity("list_teams", "team", "all", { count: teamList.length }, true);
    return teamList;
  }

  async getTeam(teamId: string): Promise<Team> {
    const team = await this.client.team(teamId);
    this.logActivity("get_team", "team", teamId, { name: team.name }, true);
    return team;
  }

  async createIssue(input: LinearIssueInput): Promise<Issue> {
    const issuePayload = await this.client.createIssue({
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
      },
      true
    );

    return issue;
  }

  async getIssue(issueId: string): Promise<Issue> {
    const issue = await this.client.issue(issueId);
    this.logActivity(
      "get_issue",
      "issue",
      issueId,
      {
        title: issue.title,
        identifier: issue.identifier,
      },
      true
    );
    return issue;
  }

  async updateIssue(issueId: string, updates: Partial<LinearIssueInput>): Promise<Issue> {
    const updatePayload = await this.client.updateIssue(issueId, {
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

    this.logActivity("update_issue", "issue", issueId, updates, true);
    return issue;
  }

  async deleteIssue(issueId: string): Promise<void> {
    const archivePayload = await this.client.archiveIssue(issueId);

    const success = await archivePayload.success;
    if (!success) {
      throw new Error("Failed to archive issue");
    }

    this.logActivity("delete_issue", "issue", issueId, { action: "archived" }, true);
  }

  async searchIssues(filters: LinearSearchFilters): Promise<Issue[]> {
    const filterObject: Record<string, string | number | boolean | object | null | undefined> = {};

    if (filters.query) {
      filterObject.or = [
        { title: { containsIgnoreCase: filters.query } },
        { description: { containsIgnoreCase: filters.query } },
      ];
    }

    if (filters.team) {
      const teams = await this.getTeams();
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
      const users = await this.getUsers();
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

    const query = this.client.issues({
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
        filters: { ...filters } as ActivityDetailObject,
        count: issueList.length,
      },
      true
    );

    return issueList;
  }

  async createComment(input: LinearCommentInput): Promise<Comment> {
    const commentPayload = await this.client.createComment({
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
      },
      true
    );

    return comment;
  }

  async getProjects(teamId?: string): Promise<Project[]> {
    // Linear SDK v51 requires manual team filtering on projects
    const query = this.client.projects({
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
      },
      true
    );

    return projectList;
  }

  async getProject(projectId: string): Promise<Project> {
    const project = await this.client.project(projectId);
    this.logActivity(
      "get_project",
      "project",
      projectId,
      {
        name: project.name,
      },
      true
    );
    return project;
  }

  async getUsers(): Promise<User[]> {
    const users = await this.client.users();
    const userList = await users.nodes;

    this.logActivity(
      "list_users",
      "user",
      "all",
      {
        count: userList.length,
      },
      true
    );

    return userList;
  }

  async getCurrentUser(): Promise<User> {
    const user = await this.client.viewer;
    this.logActivity(
      "get_current_user",
      "user",
      user.id,
      {
        email: user.email,
        name: user.name,
      },
      true
    );
    return user;
  }

  async getUserTeams(): Promise<Team[]> {
    const viewer = await this.client.viewer;
    const teams = await viewer.teams();
    const teamList = await teams.nodes;

    this.logActivity(
      "list_user_teams",
      "team",
      viewer.id,
      {
        count: teamList.length,
      },
      true
    );

    return teamList;
  }

  async getLabels(teamId?: string): Promise<IssueLabel[]> {
    const query = this.client.issueLabels({
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
      },
      true
    );

    return labelList;
  }

  async getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    const states = await this.client.workflowStates({
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
      },
      true
    );

    return stateList;
  }
}
