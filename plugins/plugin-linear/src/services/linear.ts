import { logger, Service, type IAgentRuntime } from '@elizaos/core';
import { LinearClient, Issue, Project, Team, User, WorkflowState, IssueLabel, Comment } from '@linear/sdk';
import type { 
  LinearConfig, 
  LinearActivityItem, 
  LinearIssueInput, 
  LinearCommentInput,
  LinearSearchFilters 
} from '../types';
import { LinearAPIError, LinearAuthenticationError } from '../types';

export class LinearService extends Service {
  static serviceType = 'linear';
  
  capabilityDescription = 'Linear API integration for issue tracking, project management, and team collaboration';
  
  private client: LinearClient;
  private activityLog: LinearActivityItem[] = [];
  private linearConfig: LinearConfig;
  private workspaceId?: string;
  
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    
    // Get config from runtime settings
    const apiKey = runtime?.getSetting('LINEAR_API_KEY') as string;
    const workspaceId = runtime?.getSetting('LINEAR_WORKSPACE_ID') as string;
    
    if (!apiKey) {
      throw new LinearAuthenticationError('Linear API key is required');
    }
    
    this.linearConfig = {
      LINEAR_API_KEY: apiKey,
      LINEAR_WORKSPACE_ID: workspaceId,
    };
    
    this.workspaceId = workspaceId;
    
    this.config = {
      LINEAR_API_KEY: apiKey,
      LINEAR_WORKSPACE_ID: workspaceId,
    };
    
    this.client = new LinearClient({
      apiKey: this.linearConfig.LINEAR_API_KEY,
    });
  }
  
  static async start(runtime: IAgentRuntime): Promise<LinearService> {
    const service = new LinearService(runtime);
    await service.validateConnection();
    logger.info('Linear service started successfully');
    return service;
  }
  
  async stop(): Promise<void> {
    this.activityLog = [];
    logger.info('Linear service stopped');
  }
  
  // Validate the API connection
  private async validateConnection(): Promise<void> {
    try {
      const viewer = await this.client.viewer;
      logger.info(`Linear connected as user: ${viewer.email}`);
    } catch (error) {
      throw new LinearAuthenticationError('Failed to authenticate with Linear API');
    }
  }
  
  // Log activity
  private logActivity(
    action: string,
    resourceType: LinearActivityItem['resource_type'],
    resourceId: string,
    details: Record<string, any>,
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
    
    // Keep only last 1000 activities
    if (this.activityLog.length > 1000) {
      this.activityLog = this.activityLog.slice(-1000);
    }
  }
  
  // Get activity log
  getActivityLog(limit?: number, filter?: Partial<LinearActivityItem>): LinearActivityItem[] {
    let filtered = [...this.activityLog];
    
    if (filter) {
      filtered = filtered.filter(item => {
        return Object.entries(filter).every(([key, value]) => {
          return item[key as keyof LinearActivityItem] === value;
        });
      });
    }
    
    return filtered.slice(-(limit || 100));
  }
  
  // Clear activity log
  clearActivityLog(): void {
    this.activityLog = [];
    logger.info('Linear activity log cleared');
  }
  
  // Team operations
  async getTeams(): Promise<Team[]> {
    try {
      const teams = await this.client.teams();
      const teamList = await teams.nodes;
      
      this.logActivity('list_teams', 'team', 'all', { count: teamList.length }, true);
      return teamList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('list_teams', 'team', 'all', {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch teams: ${errorMessage}`);
    }
  }
  
  async getTeam(teamId: string): Promise<Team> {
    try {
      const team = await this.client.team(teamId);
      this.logActivity('get_team', 'team', teamId, { name: team.name }, true);
      return team;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('get_team', 'team', teamId, {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch team: ${errorMessage}`);
    }
  }
  
  // Issue operations
  async createIssue(input: LinearIssueInput): Promise<Issue> {
    try {
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
        throw new Error('Failed to create issue');
      }
      
      this.logActivity('create_issue', 'issue', issue.id, { 
        title: input.title,
        teamId: input.teamId 
      }, true);
      
      return issue;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('create_issue', 'issue', 'new', input, false, errorMessage);
      throw new LinearAPIError(`Failed to create issue: ${errorMessage}`);
    }
  }
  
  async getIssue(issueId: string): Promise<Issue> {
    try {
      const issue = await this.client.issue(issueId);
      this.logActivity('get_issue', 'issue', issueId, { 
        title: issue.title,
        identifier: issue.identifier 
      }, true);
      return issue;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('get_issue', 'issue', issueId, {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch issue: ${errorMessage}`);
    }
  }
  
  async updateIssue(issueId: string, updates: Partial<LinearIssueInput>): Promise<Issue> {
    try {
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
        throw new Error('Failed to update issue');
      }
      
      this.logActivity('update_issue', 'issue', issueId, updates, true);
      return issue;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('update_issue', 'issue', issueId, updates, false, errorMessage);
      throw new LinearAPIError(`Failed to update issue: ${errorMessage}`);
    }
  }
  
  async deleteIssue(issueId: string): Promise<void> {
    try {
      // In Linear, we archive issues rather than delete them
      const archivePayload = await this.client.archiveIssue(issueId);
      
      const success = await archivePayload.success;
      if (!success) {
        throw new Error('Failed to archive issue');
      }
      
      this.logActivity('delete_issue', 'issue', issueId, { action: 'archived' }, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('delete_issue', 'issue', issueId, { action: 'archive_failed' }, false, errorMessage);
      throw new LinearAPIError(`Failed to archive issue: ${errorMessage}`);
    }
  }
  
  async searchIssues(filters: LinearSearchFilters): Promise<Issue[]> {
    try {
      // Build the filter object based on provided filters
      let filterObject: any = {};
      
      // Add text search filter
      if (filters.query) {
        filterObject.or = [
          { title: { containsIgnoreCase: filters.query } },
          { description: { containsIgnoreCase: filters.query } },
        ];
      }
      
      // Add team filter
      if (filters.team) {
        // First try to find the team by key or name
        const teams = await this.getTeams();
        const team = teams.find(t => 
          t.key.toLowerCase() === filters.team?.toLowerCase() ||
          t.name.toLowerCase() === filters.team?.toLowerCase()
        );
        
        if (team) {
          filterObject.team = { id: { eq: team.id } };
        }
      }
      
      // Add assignee filter
      if (filters.assignee && filters.assignee.length > 0) {
        const users = await this.getUsers();
        const assigneeIds = filters.assignee.map(assigneeName => {
          const user = users.find(u => 
            u.email === assigneeName || 
            u.name.toLowerCase().includes(assigneeName.toLowerCase())
          );
          return user?.id;
        }).filter(Boolean);
        
        if (assigneeIds.length > 0) {
          filterObject.assignee = { id: { in: assigneeIds } };
        }
      }
      
      // Add priority filter
      if (filters.priority && filters.priority.length > 0) {
        filterObject.priority = { number: { in: filters.priority } };
      }
      
      // Add state filter
      if (filters.state && filters.state.length > 0) {
        filterObject.state = { 
          name: { in: filters.state }
        };
      }
      
      // Add label filter
      if (filters.label && filters.label.length > 0) {
        filterObject.labels = {
          some: {
            name: { in: filters.label }
          }
        };
      }
      
      const query = this.client.issues({
        first: filters.limit || 50,
        filter: Object.keys(filterObject).length > 0 ? filterObject : undefined,
      });
      
      const issues = await query;
      const issueList = await issues.nodes;
      
      this.logActivity('search_issues', 'issue', 'search', { 
        filters,
        count: issueList.length 
      }, true);
      
      return issueList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('search_issues', 'issue', 'search', filters, false, errorMessage);
      throw new LinearAPIError(`Failed to search issues: ${errorMessage}`);
    }
  }
  
  // Comment operations
  async createComment(input: LinearCommentInput): Promise<Comment> {
    try {
      const commentPayload = await this.client.createComment({
        body: input.body,
        issueId: input.issueId,
      });
      
      const comment = await commentPayload.comment;
      if (!comment) {
        throw new Error('Failed to create comment');
      }
      
      this.logActivity('create_comment', 'comment', comment.id, { 
        issueId: input.issueId,
        bodyLength: input.body.length 
      }, true);
      
      return comment;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('create_comment', 'comment', 'new', input, false, errorMessage);
      throw new LinearAPIError(`Failed to create comment: ${errorMessage}`);
    }
  }
  
  // Project operations
  async getProjects(teamId?: string): Promise<Project[]> {
    try {
      // Note: Linear SDK v51 may not support direct team filtering on projects
      // Get all projects and filter manually if needed
      const query = this.client.projects({
        first: 100,
      });
      
      const projects = await query;
      let projectList = await projects.nodes;
      
      // Manual filtering by team if teamId is provided
      if (teamId) {
        const filteredProjects = await Promise.all(
          projectList.map(async (project) => {
            const projectTeams = await project.teams();
            const teamsList = await projectTeams.nodes;
            const hasTeam = teamsList.some((team: any) => team.id === teamId);
            return hasTeam ? project : null;
          })
        );
        projectList = filteredProjects.filter(Boolean) as Project[];
      }
      
      this.logActivity('list_projects', 'project', 'all', { 
        count: projectList.length,
        teamId 
      }, true);
      
      return projectList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('list_projects', 'project', 'all', { teamId }, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch projects: ${errorMessage}`);
    }
  }
  
  async getProject(projectId: string): Promise<Project> {
    try {
      const project = await this.client.project(projectId);
      this.logActivity('get_project', 'project', projectId, { 
        name: project.name 
      }, true);
      return project;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('get_project', 'project', projectId, {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch project: ${errorMessage}`);
    }
  }
  
  // User operations
  async getUsers(): Promise<User[]> {
    try {
      const users = await this.client.users();
      const userList = await users.nodes;
      
      this.logActivity('list_users', 'user', 'all', { 
        count: userList.length 
      }, true);
      
      return userList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('list_users', 'user', 'all', {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch users: ${errorMessage}`);
    }
  }
  
  async getCurrentUser(): Promise<User> {
    try {
      const user = await this.client.viewer;
      this.logActivity('get_current_user', 'user', user.id, { 
        email: user.email,
        name: user.name 
      }, true);
      return user;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('get_current_user', 'user', 'current', {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch current user: ${errorMessage}`);
    }
  }
  
  // Label operations
  async getLabels(teamId?: string): Promise<IssueLabel[]> {
    try {
      const query = this.client.issueLabels({
        first: 100,
        filter: teamId ? {
          team: { id: { eq: teamId } },
        } : undefined,
      });
      
      const labels = await query;
      const labelList = await labels.nodes;
      
      this.logActivity('list_labels', 'label', 'all', { 
        count: labelList.length,
        teamId 
      }, true);
      
      return labelList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('list_labels', 'label', 'all', { teamId }, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch labels: ${errorMessage}`);
    }
  }
  
  // Workflow state operations
  async getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    try {
      const states = await this.client.workflowStates({
        filter: {
          team: { id: { eq: teamId } },
        },
      });
      
      const stateList = await states.nodes;
      
      this.logActivity('list_workflow_states', 'team', teamId, { 
        count: stateList.length 
      }, true);
      
      return stateList;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logActivity('list_workflow_states', 'team', teamId, {}, false, errorMessage);
      throw new LinearAPIError(`Failed to fetch workflow states: ${errorMessage}`);
    }
  }
} 