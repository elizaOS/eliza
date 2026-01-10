import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';

const getIssueTemplate = `Extract issue identification from the user's request.

User request: "{{userMessage}}"

The user might reference an issue by:
- Direct ID (e.g., "ENG-123", "COM2-7")
- Title keywords (e.g., "the login bug", "that payment issue")
- Assignee (e.g., "John's high priority task")
- Recency (e.g., "the latest bug", "most recent issue")
- Team context (e.g., "newest issue in ELIZA team")

Return ONLY a JSON object:
{
  "directId": "Issue ID if explicitly mentioned (e.g., ENG-123)",
  "searchBy": {
    "title": "Keywords from issue title if mentioned",
    "assignee": "Name/email of assignee if mentioned", 
    "priority": "Priority level if mentioned (urgent/high/normal/low or 1-4)",
    "team": "Team name or key if mentioned",
    "state": "Issue state if mentioned (todo/in-progress/done)",
    "recency": "latest/newest/recent/last if mentioned",
    "type": "bug/feature/task if mentioned"
  }
}

Only include fields that are clearly mentioned or implied.`;

export const getIssueAction: Action = {
  name: 'GET_LINEAR_ISSUE',
  description: 'Get details of a specific Linear issue',
  similes: ['get-linear-issue', 'show-linear-issue', 'view-linear-issue', 'check-linear-issue', 'find-linear-issue'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Show me issue ENG-123'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll get the details for issue ENG-123.',
        actions: ['GET_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'What\'s the status of the login bug?'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'Let me find the login bug issue for you.',
        actions: ['GET_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Show me the latest high priority issue assigned to Sarah'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll find the latest high priority issue assigned to Sarah.',
        actions: ['GET_LINEAR_ISSUE']
      }
    }
  ]],
  
  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    try {
      const apiKey = runtime.getSetting('LINEAR_API_KEY');
      return !!apiKey;
    } catch {
      return false;
    }
  },
  
  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>('linear');
      if (!linearService) {
        throw new Error('Linear service not available');
      }
      
      const content = message.content.text;
      if (!content) {
        const errorMessage = 'Please specify which issue you want to see.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      // Use LLM to understand the request
      const prompt = getIssueTemplate.replace('{{userMessage}}', content);
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: prompt
      });
      
      if (!response) {
        // Fallback to regex
        const issueMatch = content.match(/(\w+-\d+)/);
        if (issueMatch) {
          const issue = await linearService.getIssue(issueMatch[1]);
          return await formatIssueResponse(issue, callback, message);
        }
        throw new Error('Could not understand issue reference');
      }
      
      try {
        const parsed = JSON.parse(response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim());
        
        // If direct ID is provided, use it
        if (parsed.directId) {
          const issue = await linearService.getIssue(parsed.directId);
          return await formatIssueResponse(issue, callback, message);
        }
        
        // Otherwise, search based on criteria
        if (parsed.searchBy && Object.keys(parsed.searchBy).length > 0) {
          const filters: any = {};
          
          // Build search filters
          if (parsed.searchBy.title) {
            filters.query = parsed.searchBy.title;
          }
          
          if (parsed.searchBy.assignee) {
            filters.assignee = [parsed.searchBy.assignee];
          }
          
          if (parsed.searchBy.priority) {
            const priorityMap: Record<string, number> = {
              'urgent': 1, 'high': 2, 'normal': 3, 'low': 4,
              '1': 1, '2': 2, '3': 3, '4': 4
            };
            const priority = priorityMap[parsed.searchBy.priority.toLowerCase()];
            if (priority) {
              filters.priority = [priority];
            }
          }
          
          if (parsed.searchBy.team) {
            filters.team = parsed.searchBy.team;
          }
          
          if (parsed.searchBy.state) {
            filters.state = [parsed.searchBy.state];
          }
          
          // Apply default team if configured
          const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
          if (defaultTeamKey && !filters.team) {
            filters.team = defaultTeamKey;
          }
          
          // Search for issues
          const issues = await linearService.searchIssues({
            ...filters,
            limit: parsed.searchBy.recency ? 10 : 5
          });
          
          if (issues.length === 0) {
            const noResultsMessage = 'No issues found matching your criteria.';
            await callback?.({
              text: noResultsMessage,
              source: message.content.source
            });
            return {
              text: noResultsMessage,
              success: false
            };
          }
          
          // Sort by creation date if looking for recent
          if (parsed.searchBy.recency) {
            issues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          }
          
          // If looking for recent/latest, return the first one
          if (parsed.searchBy.recency && issues.length > 0) {
            return await formatIssueResponse(issues[0], callback, message);
          }
          
          // If only one result, return it
          if (issues.length === 1) {
            return await formatIssueResponse(issues[0], callback, message);
          }
          
          // Multiple results - ask user to be more specific
          const issueList = await Promise.all(issues.slice(0, 5).map(async (issue, index) => {
            const state = await issue.state;
            return `${index + 1}. ${issue.identifier}: ${issue.title} (${state?.name || 'No state'})`;
          }));
          
          const clarifyMessage = `Found ${issues.length} issues matching your criteria:\n${issueList.join('\n')}\n\nPlease specify which one you want to see by its ID.`;
          await callback?.({
            text: clarifyMessage,
            source: message.content.source
          });
          
          return {
            text: clarifyMessage,
            success: true,
            data: {
              multipleResults: true,
              issues: issues.slice(0, 5).map(i => ({
                id: i.id,
                identifier: i.identifier,
                title: i.title
              }))
            }
          };
        }
        
      } catch (parseError) {
        logger.warn('Failed to parse LLM response, falling back to regex:', parseError);
        // Fallback to regex
        const issueMatch = content.match(/(\w+-\d+)/);
        if (issueMatch) {
          const issue = await linearService.getIssue(issueMatch[1]);
          return await formatIssueResponse(issue, callback, message);
        }
      }
      
      const errorMessage = 'Could not understand which issue you want to see. Please provide an issue ID (e.g., ENG-123) or describe it more specifically.';
      await callback?.({
        text: errorMessage,
        source: message.content.source
      });
      return {
        text: errorMessage,
        success: false
      };
      
    } catch (error) {
      logger.error('Failed to get issue:', error);
      const errorMessage = `❌ Failed to get issue: ${error instanceof Error ? error.message : 'Unknown error'}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source
      });
      return {
        text: errorMessage,
        success: false
      };
    }
  }
};

// Helper function to format issue response
async function formatIssueResponse(issue: any, callback: HandlerCallback | undefined, message: Memory): Promise<ActionResult> {
  const assignee = await issue.assignee;
  const state = await issue.state;
  const team = await issue.team;
  const labels = await issue.labels();
  const project = await issue.project;
  
  const issueDetails = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    estimate: issue.estimate,
    assignee: assignee ? {
      id: assignee.id,
      name: assignee.name,
      email: assignee.email,
    } : null,
    state: state ? {
      id: state.id,
      name: state.name,
      type: state.type,
      color: state.color,
    } : null,
    team: team ? {
      id: team.id,
      name: team.name,
      key: team.key,
    } : null,
    labels: labels.nodes.map((label: any) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
    project: project ? {
      id: project.id,
      name: project.name,
      description: project.description,
    } : null,
  };
  
  const priorityLabels = ['', 'Urgent', 'High', 'Normal', 'Low'];
  const priority = priorityLabels[issue.priority || 0] || 'No priority';
  
  const labelText = issueDetails.labels.length > 0 
    ? `Labels: ${issueDetails.labels.map((l: any) => l.name).join(', ')}`
    : '';
  
  const issueMessage = `📋 **${issue.identifier}: ${issue.title}**
  
Status: ${state?.name || 'No status'}
Priority: ${priority}
Team: ${team?.name || 'No team'}
Assignee: ${assignee?.name || 'Unassigned'}
${issue.dueDate ? `Due: ${new Date(issue.dueDate).toLocaleDateString()}` : ''}
${labelText}
${project ? `Project: ${project.name}` : ''}

${issue.description || 'No description'}

View in Linear: ${issue.url}`;
  
  await callback?.({
    text: issueMessage,
    source: message.content.source
  });
  
  return {
    text: `Retrieved issue ${issue.identifier}: ${issue.title}`,
    success: true,
    data: { issue: issueDetails }
  };
} 