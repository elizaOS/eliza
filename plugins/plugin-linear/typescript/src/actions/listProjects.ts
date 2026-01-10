import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';

const listProjectsTemplate = `Extract project filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for projects in various ways:
- "Show me all projects" → list all projects
- "Active projects" → filter by state (active/planned/completed)
- "Projects due this quarter" → filter by target date
- "Which projects is Sarah managing?" → filter by lead/owner
- "Projects with high priority issues" → filter by contained issue priority
- "Projects for the engineering team" → filter by team
- "Completed projects" → filter by state
- "Projects starting next month" → filter by start date

Return ONLY a JSON object:
{
  "teamFilter": "Team name or key if mentioned",
  "stateFilter": "active/planned/completed/all",
  "dateFilter": {
    "type": "due/starting",
    "period": "this-week/this-month/this-quarter/next-month/next-quarter",
    "from": "ISO date if specific",
    "to": "ISO date if specific"
  },
  "leadFilter": "Project lead name if mentioned",
  "showAll": true/false (true if user explicitly asks for "all")
}

Only include fields that are clearly mentioned.`;

export const listProjectsAction: Action = {
  name: 'LIST_LINEAR_PROJECTS',
  description: 'List projects in Linear with optional filters',
  similes: ['list-linear-projects', 'show-linear-projects', 'get-linear-projects', 'view-linear-projects'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Show me all projects'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll list all the projects in Linear for you.',
        actions: ['LIST_LINEAR_PROJECTS']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'What active projects do we have?'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'Let me show you all the active projects.',
        actions: ['LIST_LINEAR_PROJECTS']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Show me projects for the engineering team'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll find the projects for the engineering team.',
        actions: ['LIST_LINEAR_PROJECTS']
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
      
      const content = message.content.text || '';
      let teamId: string | undefined;
      let showAll = false;
      let stateFilter: string | undefined;
      
      // Use LLM to parse the request
      if (content) {
        const prompt = listProjectsTemplate.replace('{{userMessage}}', content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (response) {
          try {
            const parsed = JSON.parse(response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim());
            
            // Handle team filter
            if (parsed.teamFilter) {
              const teams = await linearService.getTeams();
              const team = teams.find(t => 
                t.key.toLowerCase() === parsed.teamFilter.toLowerCase() ||
                t.name.toLowerCase() === parsed.teamFilter.toLowerCase()
              );
              if (team) {
                teamId = team.id;
                logger.info(`Filtering projects by team: ${team.name} (${team.key})`);
              }
            }
            
            // Handle show all flag
            showAll = parsed.showAll === true;
            
            // Handle state filter
            stateFilter = parsed.stateFilter;
            
            // Note: Date filters and lead filters would require API enhancements
            if (parsed.dateFilter || parsed.leadFilter) {
              logger.info('Date and lead filters noted but not yet implemented');
            }
            
          } catch (parseError) {
            logger.warn('Failed to parse project filters, using basic parsing:', parseError);
            
            // Fallback to basic parsing
            const teamMatch = content.match(/(?:for|in|of)\s+(?:the\s+)?(\w+)\s+team/i);
            if (teamMatch) {
              const teams = await linearService.getTeams();
              const team = teams.find(t => 
                t.key.toLowerCase() === teamMatch[1].toLowerCase() ||
                t.name.toLowerCase() === teamMatch[1].toLowerCase()
              );
              if (team) {
                teamId = team.id;
                logger.info(`Filtering projects by team: ${team.name} (${team.key})`);
              }
            }
            
            showAll = content.toLowerCase().includes('all') && content.toLowerCase().includes('project');
          }
        }
      }
      
      // Apply default team filter if configured and user didn't ask for "all" projects
      if (!teamId && !showAll) {
        const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
        if (defaultTeamKey) {
          const teams = await linearService.getTeams();
          const defaultTeam = teams.find(t => 
            t.key.toLowerCase() === defaultTeamKey.toLowerCase()
          );
          if (defaultTeam) {
            teamId = defaultTeam.id;
            logger.info(`Applying default team filter for projects: ${defaultTeam.name} (${defaultTeam.key})`);
          }
        }
      }
      
      let projects = await linearService.getProjects(teamId);
      
      // Client-side filtering by state if needed
      if (stateFilter && stateFilter !== 'all') {
        projects = projects.filter(project => {
          const state = project.state?.toLowerCase() || '';
          if (stateFilter === 'active') {
            return state === 'started' || state === 'in progress' || !state;
          } else if (stateFilter === 'planned') {
            return state === 'planned' || state === 'backlog';
          } else if (stateFilter === 'completed') {
            return state === 'completed' || state === 'done' || state === 'canceled';
          }
          return true;
        });
      }
      
      if (projects.length === 0) {
        const noProjectsMessage = teamId 
          ? 'No projects found for the specified team.'
          : 'No projects found in Linear.';
        await callback?.({
          text: noProjectsMessage,
          source: message.content.source
        });
        return {
          text: noProjectsMessage,
          success: true,
          data: {
            projects: []
          }
        };
      }
      
      // Get teams for each project
      const projectsWithDetails = await Promise.all(
        projects.map(async (project) => {
          const teamsQuery = await project.teams();
          const teams = await teamsQuery.nodes;
          const lead = await project.lead;
          
          return {
            ...project,
            teamsList: teams,
            leadUser: lead
          };
        })
      );
      
      const projectList = projectsWithDetails.map((project, index) => {
        const teamNames = project.teamsList.map((t: any) => t.name).join(', ') || 'No teams';
        const status = project.state || 'Active';
        const progress = project.progress ? ` (${Math.round(project.progress * 100)}% complete)` : '';
        const lead = project.leadUser ? ` | Lead: ${project.leadUser.name}` : '';
        const dates = [];
        if (project.startDate) dates.push(`Start: ${new Date(project.startDate).toLocaleDateString()}`);
        if (project.targetDate) dates.push(`Due: ${new Date(project.targetDate).toLocaleDateString()}`);
        const dateInfo = dates.length > 0 ? `\n   ${dates.join(' | ')}` : '';
        
        return `${index + 1}. ${project.name}${project.description ? ` - ${project.description}` : ''}\n   Status: ${status}${progress} | Teams: ${teamNames}${lead}${dateInfo}`;
      }).join('\n\n');
      
      const headerText = stateFilter && stateFilter !== 'all'
        ? `📁 Found ${projects.length} ${stateFilter} project${projects.length === 1 ? '' : 's'}:`
        : `📁 Found ${projects.length} project${projects.length === 1 ? '' : 's'}:`;
      
      const resultMessage = `${headerText}\n\n${projectList}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source
      });
      
      return {
        text: `Found ${projects.length} project${projects.length === 1 ? '' : 's'}`,
        success: true,
        data: {
          projects: projectsWithDetails.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            url: p.url,
            teams: p.teamsList.map((t: any) => ({
              id: t.id,
              name: t.name,
              key: t.key
            })),
            lead: p.leadUser ? {
              id: p.leadUser.id,
              name: p.leadUser.name,
              email: p.leadUser.email
            } : null,
            state: p.state,
            progress: p.progress,
            startDate: p.startDate,
            targetDate: p.targetDate
          })),
          count: projects.length,
          filters: {
            team: teamId,
            state: stateFilter
          }
        }
      };
    } catch (error) {
      logger.error('Failed to list projects:', error);
      const errorMessage = `❌ Failed to list projects: ${error instanceof Error ? error.message : 'Unknown error'}`;
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