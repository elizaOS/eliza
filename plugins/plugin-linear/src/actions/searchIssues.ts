import {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  ModelType,
  logger,
  HandlerCallback,
} from '@elizaos/core';
import { LinearService } from '../services/linear';
import type { LinearSearchFilters } from '../types';

const searchTemplate = `Extract search criteria from the user's request for Linear issues.

User request: "{{userMessage}}"

The user might express searches in various ways:
- "Show me what John is working on" → assignee filter
- "Any blockers for the next release?" → priority/label filters
- "Issues created this week" → date range filter
- "My high priority bugs" → assignee (current user) + priority + label
- "Unassigned tasks in the backend team" → no assignee + team filter
- "What did Sarah close yesterday?" → assignee + state + date
- "Bugs that are almost done" → label + state filter
- "Show me the oldest open issues" → state + sort order

Extract and return ONLY a JSON object:
{
  "query": "General search text for title/description",
  "states": ["state names like In Progress, Done, Todo, Backlog"],
  "assignees": ["assignee names or emails, or 'me' for current user"],
  "priorities": ["urgent/high/normal/low or 1/2/3/4"],
  "teams": ["team names or keys"],
  "labels": ["label names"],
  "hasAssignee": true/false (true = has assignee, false = unassigned),
  "dateRange": {
    "field": "created/updated/completed",
    "period": "today/yesterday/this-week/last-week/this-month/last-month",
    "from": "ISO date if specific date",
    "to": "ISO date if specific date"
  },
  "sort": {
    "field": "created/updated/priority",
    "order": "asc/desc"
  },
  "limit": number (default 10)
}

Only include fields that are clearly mentioned or implied. For "my" issues, set assignees to ["me"].`;

export const searchIssuesAction: Action = {
  name: 'SEARCH_LINEAR_ISSUES',
  description: 'Search for issues in Linear with various filters',
  similes: ['search-linear-issues', 'find-linear-issues', 'query-linear-issues', 'list-linear-issues'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Show me all open bugs'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll search for all open bug issues in Linear.',
        actions: ['SEARCH_LINEAR_ISSUES']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'What is John working on?'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll find the issues assigned to John.',
        actions: ['SEARCH_LINEAR_ISSUES']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Show me high priority issues created this week'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll search for high priority issues created this week.',
        actions: ['SEARCH_LINEAR_ISSUES']
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
        const errorMessage = 'Please provide search criteria for issues.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      let filters: LinearSearchFilters = {};
      
      // Check if we have explicit filters in options
      if (_options?.filters) {
        filters = _options.filters as LinearSearchFilters;
      } else {
        // Use LLM to extract search filters
        const prompt = searchTemplate.replace('{{userMessage}}', content);
        
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (!response) {
          // Fallback to simple keyword search
          filters = { query: content };
        } else {
          try {
            // Strip markdown code blocks if present
            const cleanedResponse = response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
            const parsed = JSON.parse(cleanedResponse);
            
            // Build filters object
            filters = {
              query: parsed.query,
              limit: parsed.limit || 10
            };
            
            // Handle states
            if (parsed.states && parsed.states.length > 0) {
              filters.state = parsed.states;
            }
            
            // Handle assignees
            if (parsed.assignees && parsed.assignees.length > 0) {
              // Replace "me" with current user if we can get it
              const processedAssignees = [];
              for (const assignee of parsed.assignees) {
                if (assignee.toLowerCase() === 'me') {
                  // Try to get current user
                  try {
                    const currentUser = await linearService.getCurrentUser();
                    processedAssignees.push(currentUser.email);
                  } catch {
                    // If we can't get current user, skip "me"
                    logger.warn('Could not resolve "me" to current user');
                  }
                } else {
                  processedAssignees.push(assignee);
                }
              }
              if (processedAssignees.length > 0) {
                filters.assignee = processedAssignees;
              }
            }
            
            // Handle unassigned filter
            if (parsed.hasAssignee === false) {
              // This would need special handling in the service layer
              // For now, we'll note it in the query
              filters.query = (filters.query ? filters.query + ' ' : '') + 'unassigned';
            }
            
            // Handle priorities
            if (parsed.priorities && parsed.priorities.length > 0) {
              const priorityMap: Record<string, number> = {
                'urgent': 1, 'high': 2, 'normal': 3, 'low': 4,
                '1': 1, '2': 2, '3': 3, '4': 4
              };
              const priorities = parsed.priorities
                .map((p: string) => priorityMap[p.toLowerCase()])
                .filter(Boolean);
              if (priorities.length > 0) {
                filters.priority = priorities;
              }
            }
            
            // Handle teams
            if (parsed.teams && parsed.teams.length > 0) {
              // For now, take the first team since our interface supports single team
              filters.team = parsed.teams[0];
            }
            
            // Handle labels
            if (parsed.labels && parsed.labels.length > 0) {
              filters.label = parsed.labels;
            }
            
            // Note: Date range filtering and sorting would require API enhancements
            if (parsed.dateRange || parsed.sort) {
              logger.info('Date range and sort filters noted but not yet implemented');
            }
            
            // Clean up undefined values
            Object.keys(filters).forEach(key => {
              if (filters[key as keyof LinearSearchFilters] === undefined) {
                delete filters[key as keyof LinearSearchFilters];
              }
            });
          } catch (parseError) {
            logger.error('Failed to parse search filters:', parseError);
            // Fallback to simple search
            filters = { query: content };
          }
        }
      }
      
      // Apply default team filter if configured and no team filter was specified
      if (!filters.team) {
        const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
        if (defaultTeamKey) {
          // Check if the user explicitly asked for "all" issues
          const searchingAllIssues = content.toLowerCase().includes('all') && 
                                    (content.toLowerCase().includes('issue') || 
                                     content.toLowerCase().includes('bug') || 
                                     content.toLowerCase().includes('task'));
          
          if (!searchingAllIssues) {
            filters.team = defaultTeamKey;
            logger.info(`Applying default team filter: ${defaultTeamKey}`);
          }
        }
      }
      
      filters.limit = (_options?.limit as number) || filters.limit || 10;
      
      const issues = await linearService.searchIssues(filters);
      
      if (issues.length === 0) {
        const noResultsMessage = 'No issues found matching your search criteria.';
        await callback?.({
          text: noResultsMessage,
          source: message.content.source
        });
        return {
          text: noResultsMessage,
          success: true,
          data: {
            issues: [],
            filters,
            count: 0
          }
        };
      }
      
      const issueList = await Promise.all(issues.map(async (issue, index) => {
        const state = await issue.state;
        const assignee = await issue.assignee;
        const priorityLabels = ['', 'Urgent', 'High', 'Normal', 'Low'];
        const priority = priorityLabels[issue.priority || 0] || 'No priority';
        
        return `${index + 1}. ${issue.identifier}: ${issue.title}\n   Status: ${state?.name || 'No state'} | Priority: ${priority} | Assignee: ${assignee?.name || 'Unassigned'}`;
      }));
      const issueText = issueList.join('\n\n');
      
      const resultMessage = `📋 Found ${issues.length} issue${issues.length === 1 ? '' : 's'}:\n\n${issueText}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source
      });
      
      return {
        text: `Found ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
        success: true,
        data: {
          issues: await Promise.all(issues.map(async issue => {
            const state = await issue.state;
            const assignee = await issue.assignee;
            const team = await issue.team;
            
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              url: issue.url,
              priority: issue.priority,
              state: state ? { name: state.name, type: state.type } : null,
              assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
              team: team ? { name: team.name, key: team.key } : null,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt
            };
          })),
          filters,
          count: issues.length
        }
      };
    } catch (error) {
      logger.error('Failed to search issues:', error);
      const errorMessage = `❌ Failed to search issues: ${error instanceof Error ? error.message : 'Unknown error'}`;
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