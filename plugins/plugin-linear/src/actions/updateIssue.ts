import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';
import type { LinearIssueInput } from '../types';

const updateIssueTemplate = `Given the user's request to update a Linear issue, extract the information needed.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with the following structure:
{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)",
  "updates": {
    "title": "New title if changing the title",
    "description": "New description if changing the description",
    "priority": "Priority level if changing (1=urgent, 2=high, 3=normal, 4=low)",
    "teamKey": "New team key if moving to another team (e.g., ENG, ELIZA, COM2)",
    "assignee": "New assignee username or email if changing",
    "status": "New status if changing (e.g., todo, in-progress, done, canceled)",
    "labels": ["label1", "label2"] (if changing labels, empty array to clear)
  }
}

Only include fields that are being updated. Return only the JSON object, no other text.`;

export const updateIssueAction: Action = {
  name: 'UPDATE_LINEAR_ISSUE',
  description: 'Update an existing Linear issue',
  similes: ['update-linear-issue', 'edit-linear-issue', 'modify-linear-issue', 'move-linear-issue', 'change-linear-issue'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Update issue ENG-123 title to "Fix login button on all devices"'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll update the title of issue ENG-123 for you.',
        actions: ['UPDATE_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Move issue COM2-7 to the ELIZA team'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll move issue COM2-7 to the ELIZA team.',
        actions: ['UPDATE_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Change the priority of BUG-456 to high and assign to john@example.com'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll change the priority of BUG-456 to high and assign it to john@example.com.',
        actions: ['UPDATE_LINEAR_ISSUE']
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
        const errorMessage = 'Please provide update instructions for the issue.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      // Use LLM to extract update information
      const prompt = updateIssueTemplate.replace('{{userMessage}}', content);
      
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: prompt
      });
      
      if (!response) {
        throw new Error('Failed to extract update information');
      }
      
      let issueId: string;
      let updates: Partial<LinearIssueInput> = {};
      
      try {
        // Strip markdown code blocks if present
        const cleanedResponse = response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
        const parsed = JSON.parse(cleanedResponse);
        
        issueId = parsed.issueId;
        if (!issueId) {
          throw new Error('Issue ID not found in parsed response');
        }
        
        // Handle title update
        if (parsed.updates?.title) {
          updates.title = parsed.updates.title;
        }
        
        // Handle description update
        if (parsed.updates?.description) {
          updates.description = parsed.updates.description;
        }
        
        // Handle priority update
        if (parsed.updates?.priority) {
          updates.priority = Number(parsed.updates.priority);
        }
        
        // Handle team change
        if (parsed.updates?.teamKey) {
          const teams = await linearService.getTeams();
          const team = teams.find(t => 
            t.key.toLowerCase() === parsed.updates.teamKey.toLowerCase()
          );
          if (team) {
            updates.teamId = team.id;
            logger.info(`Moving issue to team: ${team.name} (${team.key})`);
          } else {
            logger.warn(`Team with key ${parsed.updates.teamKey} not found`);
          }
        }
        
        // Handle assignee update
        if (parsed.updates?.assignee) {
          const cleanAssignee = parsed.updates.assignee.replace(/^@/, '');
          const users = await linearService.getUsers();
          const user = users.find(u => 
            u.email === cleanAssignee || 
            u.name.toLowerCase().includes(cleanAssignee.toLowerCase())
          );
          if (user) {
            updates.assigneeId = user.id;
          } else {
            logger.warn(`User ${cleanAssignee} not found`);
          }
        }
        
        // Handle status update
        if (parsed.updates?.status) {
          // Get the workflow states for the target team (or current team if not changing)
          const issue = await linearService.getIssue(issueId);
          const issueTeam = await issue.team;
          const teamId = updates.teamId || issueTeam?.id;
          if (!teamId) {
            logger.warn('Could not determine team for status update');
          } else {
            const states = await linearService.getWorkflowStates(teamId);
            
            const state = states.find(s => 
              s.name.toLowerCase() === parsed.updates.status.toLowerCase() ||
              s.type.toLowerCase() === parsed.updates.status.toLowerCase()
            );
            
            if (state) {
              updates.stateId = state.id;
              logger.info(`Changing status to: ${state.name}`);
            } else {
              logger.warn(`Status ${parsed.updates.status} not found for team`);
            }
          }
        }
        
        // Handle labels update
        if (parsed.updates?.labels && Array.isArray(parsed.updates.labels)) {
          const teamId = updates.teamId;
          const labels = await linearService.getLabels(teamId);
          const labelIds: string[] = [];
          
          for (const labelName of parsed.updates.labels) {
            if (labelName) {
              const label = labels.find(l => 
                l.name.toLowerCase() === labelName.toLowerCase()
              );
              if (label) {
                labelIds.push(label.id);
              }
            }
          }
          
          updates.labelIds = labelIds;
        }
        
      } catch (parseError) {
        // Fallback to regex parsing for simple cases
        logger.warn('Failed to parse LLM response, falling back to regex parsing:', parseError);
        
        const issueMatch = content.match(/(\w+-\d+)/);
        if (!issueMatch) {
          const errorMessage = 'Please specify an issue ID (e.g., ENG-123) to update.';
          await callback?.({
            text: errorMessage,
            source: message.content.source
          });
          return {
            text: errorMessage,
            success: false
          };
        }
        
        issueId = issueMatch[1];
        
        // Simple regex patterns for common updates
        const titleMatch = content.match(/title to ["'](.+?)["']/i);
        if (titleMatch) {
          updates.title = titleMatch[1];
        }
        
        const priorityMatch = content.match(/priority (?:to |as )?(\w+)/i);
        if (priorityMatch) {
          const priorityMap: Record<string, number> = {
            'urgent': 1,
            'high': 2,
            'normal': 3,
            'medium': 3,
            'low': 4,
          };
          const priority = priorityMap[priorityMatch[1].toLowerCase()];
          if (priority) {
            updates.priority = priority;
          }
        }
      }
      
      if (Object.keys(updates).length === 0) {
        const errorMessage = 'No valid updates found. Please specify what to update (e.g., "Update issue ENG-123 title to \'New Title\'")';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      const updatedIssue = await linearService.updateIssue(issueId, updates);
      
      const updateSummary = [];
      if (updates.title) updateSummary.push(`title: "${updates.title}"`);
      if (updates.priority) updateSummary.push(`priority: ${['', 'urgent', 'high', 'normal', 'low'][updates.priority]}`);
      if (updates.teamId) updateSummary.push(`moved to team`);
      if (updates.assigneeId) updateSummary.push(`assigned to user`);
      if (updates.stateId) updateSummary.push(`status changed`);
      if (updates.labelIds) updateSummary.push(`labels updated`);
      
      const successMessage = `✅ Updated issue ${updatedIssue.identifier}: ${updateSummary.join(', ')}\n\nView it at: ${updatedIssue.url}`;
      await callback?.({
        text: successMessage,
        source: message.content.source
      });
      
      return {
        text: `Updated issue ${updatedIssue.identifier}: ${updateSummary.join(', ')}`,
        success: true,
        data: {
          issueId: updatedIssue.id,
          identifier: updatedIssue.identifier,
          updates,
          url: updatedIssue.url
        }
      };
    } catch (error) {
      logger.error('Failed to update issue:', error);
      const errorMessage = `❌ Failed to update issue: ${error instanceof Error ? error.message : 'Unknown error'}`;
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