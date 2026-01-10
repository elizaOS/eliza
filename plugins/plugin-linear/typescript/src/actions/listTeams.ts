import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';

const listTeamsTemplate = `Extract team filter criteria from the user's request.

User request: "{{userMessage}}"

The user might ask for teams in various ways:
- "Show me all teams" → list all teams
- "Engineering teams" → filter by teams with engineering in name/description
- "List teams I'm part of" → filter by membership
- "Which teams work on the mobile app?" → filter by description/focus
- "Show me the ELIZA team details" → specific team lookup
- "Active teams" → teams with recent activity
- "Frontend and backend teams" → multiple team types

Return ONLY a JSON object:
{
  "nameFilter": "Keywords to search in team names",
  "specificTeam": "Specific team name or key if looking for one team",
  "myTeams": true/false (true if user wants their teams),
  "showAll": true/false (true if user explicitly asks for "all"),
  "includeDetails": true/false (true if user wants detailed info)
}

Only include fields that are clearly mentioned.`;

export const listTeamsAction: Action = {
  name: 'LIST_LINEAR_TEAMS',
  description: 'List teams in Linear with optional filters',
  similes: ['list-linear-teams', 'show-linear-teams', 'get-linear-teams', 'view-linear-teams'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Show me all teams'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll list all the teams in Linear for you.',
        actions: ['LIST_LINEAR_TEAMS']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Which engineering teams do we have?'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'Let me find the engineering teams for you.',
        actions: ['LIST_LINEAR_TEAMS']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Show me the teams I\'m part of'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll show you the teams you\'re a member of.',
        actions: ['LIST_LINEAR_TEAMS']
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
      let nameFilter: string | undefined;
      let specificTeam: string | undefined;
      let myTeams = false;
      let includeDetails = false;
      
      // Use LLM to parse the request
      if (content) {
        const prompt = listTeamsTemplate.replace('{{userMessage}}', content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (response) {
          try {
            const parsed = JSON.parse(response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim());
            
            nameFilter = parsed.nameFilter;
            specificTeam = parsed.specificTeam;
            myTeams = parsed.myTeams === true;
            includeDetails = parsed.includeDetails === true;
            
          } catch (parseError) {
            logger.warn('Failed to parse team filters:', parseError);
          }
        }
      }
      
      let teams = await linearService.getTeams();
      
      // Filter for specific team
      if (specificTeam) {
        teams = teams.filter(team => 
          team.key.toLowerCase() === specificTeam.toLowerCase() ||
          team.name.toLowerCase() === specificTeam.toLowerCase()
        );
      }
      
      // Filter by name keywords
      if (nameFilter && !specificTeam) {
        const keywords = nameFilter.toLowerCase().split(/\s+/);
        teams = teams.filter(team => {
          const teamText = `${team.name} ${team.description || ''}`.toLowerCase();
          return keywords.some(keyword => teamText.includes(keyword));
        });
      }
      
      // Filter for user's teams if requested
      if (myTeams) {
        try {
          const currentUser = await linearService.getCurrentUser();
          // This would require fetching team membership - simplified for now
          logger.info('Team membership filtering not yet implemented');
        } catch {
          logger.warn('Could not get current user for team filtering');
        }
      }
      
      if (teams.length === 0) {
        const noTeamsMessage = specificTeam 
          ? `No team found matching "${specificTeam}".`
          : nameFilter 
            ? `No teams found matching "${nameFilter}".`
            : 'No teams found in Linear.';
        await callback?.({
          text: noTeamsMessage,
          source: message.content.source
        });
        return {
          text: noTeamsMessage,
          success: true,
          data: {
            teams: []
          }
        };
      }
      
      // Get additional details if requested or showing specific team
      let teamsWithDetails: any[] = teams;
      if (includeDetails || specificTeam) {
        teamsWithDetails = await Promise.all(teams.map(async (team) => {
          const membersQuery = await team.members();
          const members = await membersQuery.nodes;
          const projectsQuery = await team.projects();
          const projects = await projectsQuery.nodes;
          
          return {
            ...team,
            memberCount: members.length,
            projectCount: projects.length,
            membersList: specificTeam ? members.slice(0, 5) : [] // Include member details for specific team
          };
        }));
      }
      
      const teamList = teamsWithDetails.map((team: any, index) => {
        let info = `${index + 1}. ${team.name} (${team.key})`;
        
        if (team.description) {
          info += `\n   ${team.description}`;
        }
        
        if (includeDetails || specificTeam) {
          info += `\n   Members: ${team.memberCount} | Projects: ${team.projectCount}`;
          
          if (specificTeam && team.membersList.length > 0) {
            const memberNames = team.membersList.map((m: any) => m.name).join(', ');
            info += `\n   Team members: ${memberNames}${team.memberCount > 5 ? ' ...' : ''}`;
          }
        }
        
        return info;
      }).join('\n\n');
      
      const headerText = specificTeam && teams.length === 1
        ? `📋 Team Details:`
        : nameFilter 
          ? `📋 Found ${teams.length} team${teams.length === 1 ? '' : 's'} matching "${nameFilter}":`
          : `📋 Found ${teams.length} team${teams.length === 1 ? '' : 's'}:`;
      
      const resultMessage = `${headerText}\n\n${teamList}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source
      });
      
      return {
        text: `Found ${teams.length} team${teams.length === 1 ? '' : 's'}`,
        success: true,
        data: {
          teams: teamsWithDetails.map((t: any) => ({
            id: t.id,
            name: t.name,
            key: t.key,
            description: t.description,
            memberCount: t.memberCount,
            projectCount: t.projectCount
          })),
          count: teams.length,
          filters: {
            name: nameFilter,
            specific: specificTeam
          }
        }
      };
    } catch (error) {
      logger.error('Failed to list teams:', error);
      const errorMessage = `❌ Failed to list teams: ${error instanceof Error ? error.message : 'Unknown error'}`;
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