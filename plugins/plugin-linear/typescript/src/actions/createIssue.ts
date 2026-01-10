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
import type { LinearIssueInput } from '../types';

const createIssueTemplate = `Given the user's request, extract the information needed to create a Linear issue.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with the following structure:
{
  "title": "Brief, clear issue title",
  "description": "Detailed description of the issue (optional, omit or use null if not provided)",
  "teamKey": "Team key if mentioned (e.g., ENG, PROD) - omit or use null if not mentioned",
  "priority": "Priority level if mentioned (1=urgent, 2=high, 3=normal, 4=low) - omit or use null if not mentioned",
  "labels": ["label1", "label2"] (if any labels are mentioned, empty array if none),
  "assignee": "Assignee username or email if mentioned - omit or use null if not mentioned"
}

Return only the JSON object, no other text.`;

export const createIssueAction: Action = {
  name: 'CREATE_LINEAR_ISSUE',
  description: 'Create a new issue in Linear',
  similes: ['create-linear-issue', 'new-linear-issue', 'add-linear-issue'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Create a new issue: Fix login button not working on mobile devices'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll create that issue for you in Linear.',
        actions: ['CREATE_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Create a bug report for the ENG team: API returns 500 error when updating user profile'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll create a bug report for the engineering team right away.',
        actions: ['CREATE_LINEAR_ISSUE']
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
        const errorMessage = 'Please provide a description for the issue.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      // Check if the message already has structured data
      const structuredData = _options?.issueData as Partial<LinearIssueInput> | undefined;
      
      let issueData: Partial<LinearIssueInput>;
      
      if (structuredData) {
        issueData = structuredData;
      } else {
        // Use LLM to extract issue information
        const prompt = createIssueTemplate.replace('{{userMessage}}', content);
        
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (!response) {
          throw new Error('Failed to extract issue information');
        }
        
        try {
          // Strip markdown code blocks if present
          const cleanedResponse = response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
          const parsed = JSON.parse(cleanedResponse);
          
          // Clean up parsed data - convert empty strings to undefined for fields that need it
          issueData = {
            title: parsed.title || undefined,
            description: parsed.description || undefined,
            priority: parsed.priority ? Number(parsed.priority) : undefined,
          };
          
          // Handle team assignment
          if (parsed.teamKey) {
            const teams = await linearService.getTeams();
            const team = teams.find(t => 
              t.key.toLowerCase() === parsed.teamKey.toLowerCase()
            );
            if (team) {
              issueData.teamId = team.id;
            }
          }
          
          // Handle assignee
          if (parsed.assignee && parsed.assignee !== '') {
            // Clean up assignee - remove @ symbol if present
            const cleanAssignee = parsed.assignee.replace(/^@/, '');
            
            const users = await linearService.getUsers();
            const user = users.find(u => 
              u.email === cleanAssignee || 
              u.name.toLowerCase().includes(cleanAssignee.toLowerCase())
            );
            if (user) {
              issueData.assigneeId = user.id;
            }
          }
          
          // Handle labels
          if (parsed.labels && Array.isArray(parsed.labels) && parsed.labels.length > 0) {
            const labels = await linearService.getLabels(issueData.teamId);
            const labelIds: string[] = [];
            
            for (const labelName of parsed.labels) {
              if (labelName && labelName !== '') {
                const label = labels.find(l => 
                  l.name.toLowerCase() === labelName.toLowerCase()
                );
                if (label) {
                  labelIds.push(label.id);
                }
              }
            }
            
            if (labelIds.length > 0) {
              issueData.labelIds = labelIds;
            }
          }
          
          // If no team was specified, use the first available team as default
          if (!issueData.teamId) {
            // Check for default team key from environment
            const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
            
            if (defaultTeamKey) {
              const teams = await linearService.getTeams();
              const defaultTeam = teams.find(t => 
                t.key.toLowerCase() === defaultTeamKey.toLowerCase()
              );
              if (defaultTeam) {
                issueData.teamId = defaultTeam.id;
                logger.info(`Using configured default team: ${defaultTeam.name} (${defaultTeam.key})`);
              } else {
                logger.warn(`Default team key ${defaultTeamKey} not found`);
              }
            }
            
            // If still no team, fall back to first available
            if (!issueData.teamId) {
              const teams = await linearService.getTeams();
              if (teams.length > 0) {
                issueData.teamId = teams[0].id;
                logger.warn(`No team specified, using first available team: ${teams[0].name}`);
              }
            }
          }
        } catch (parseError) {
          logger.error('Failed to parse LLM response:', parseError);
          // Fallback to simple title extraction
          issueData = {
            title: content.length > 100 ? content.substring(0, 100) + '...' : content,
            description: content
          };
          
          // Ensure we have a teamId even in fallback case
          const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
          const teams = await linearService.getTeams();
          
          if (defaultTeamKey) {
            const defaultTeam = teams.find(t => 
              t.key.toLowerCase() === defaultTeamKey.toLowerCase()
            );
            if (defaultTeam) {
              issueData.teamId = defaultTeam.id;
              logger.info(`Using configured default team for fallback: ${defaultTeam.name} (${defaultTeam.key})`);
            }
          }
          
          if (!issueData.teamId && teams.length > 0) {
            issueData.teamId = teams[0].id;
            logger.warn(`Using first available team for fallback: ${teams[0].name}`);
          }
        }
      }
      
      if (!issueData.title) {
        const errorMessage = 'Could not determine issue title. Please provide more details.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      // Final check for required teamId
      if (!issueData.teamId) {
        const errorMessage = 'No Linear teams found. Please ensure at least one team exists in your Linear workspace.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      const issue = await linearService.createIssue(issueData as LinearIssueInput);
      
      // Send success message to channel
      const successMessage = `✅ Created Linear issue: ${issue.title} (${issue.identifier})\n\nView it at: ${issue.url}`;
      await callback?.({
        text: successMessage,
        source: message.content.source
      });
      
      return {
        text: `Created issue: ${issue.title} (${issue.identifier})`,
        success: true,
        data: {
          issueId: issue.id,
          identifier: issue.identifier,
          url: issue.url
        }
      };
    } catch (error) {
      logger.error('Failed to create issue:', error);
      const errorMessage = `❌ Failed to create issue: ${error instanceof Error ? error.message : 'Unknown error'}`;
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