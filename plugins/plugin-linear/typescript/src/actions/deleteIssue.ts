import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';

const deleteIssueTemplate = `Given the user's request to delete/archive a Linear issue, extract the issue identifier.

User request: "{{userMessage}}"

Extract and return ONLY a JSON object (no markdown formatting, no code blocks) with:
{
  "issueId": "The issue identifier (e.g., ENG-123, COM2-7)"
}

Return only the JSON object, no other text.`;

export const deleteIssueAction: Action = {
  name: 'DELETE_LINEAR_ISSUE',
  description: 'Delete (archive) an issue in Linear',
  similes: ['delete-linear-issue', 'archive-linear-issue', 'remove-linear-issue', 'close-linear-issue'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Delete issue ENG-123'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll archive issue ENG-123 for you.',
        actions: ['DELETE_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Remove COM2-7 from Linear'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll archive issue COM2-7 in Linear.',
        actions: ['DELETE_LINEAR_ISSUE']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Archive the bug report BUG-456'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll archive issue BUG-456 for you.',
        actions: ['DELETE_LINEAR_ISSUE']
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
        const errorMessage = 'Please specify which issue to delete.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      let issueId: string;
      
      // Check if we have issueId in options
      if (_options?.issueId) {
        issueId = _options.issueId as string;
      } else {
        // Use LLM to extract issue ID
        const prompt = deleteIssueTemplate.replace('{{userMessage}}', content);
        
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (!response) {
          throw new Error('Failed to extract issue identifier');
        }
        
        try {
          // Strip markdown code blocks if present
          const cleanedResponse = response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
          const parsed = JSON.parse(cleanedResponse);
          
          issueId = parsed.issueId;
          if (!issueId) {
            throw new Error('Issue ID not found in parsed response');
          }
        } catch (parseError) {
          // Fallback to regex parsing
          logger.warn('Failed to parse LLM response, falling back to regex parsing:', parseError);
          
          const issueMatch = content.match(/(\w+-\d+)/);
          if (!issueMatch) {
            const errorMessage = 'Please specify an issue ID (e.g., ENG-123) to delete.';
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
        }
      }
      
      // Get issue details before deletion to confirm and show title
      const issue = await linearService.getIssue(issueId);
      const issueTitle = issue.title;
      const issueIdentifier = issue.identifier;
      
      // Confirm deletion with user-friendly message
      logger.info(`Archiving issue ${issueIdentifier}: ${issueTitle}`);
      
      // Archive the issue (Linear doesn't support hard deletion)
      await linearService.deleteIssue(issueId);
      
      const successMessage = `✅ Successfully archived issue ${issueIdentifier}: "${issueTitle}"\n\nThe issue has been moved to the archived state and will no longer appear in active views.`;
      await callback?.({
        text: successMessage,
        source: message.content.source
      });
      
      return {
        text: `Archived issue ${issueIdentifier}: "${issueTitle}"`,
        success: true,
        data: {
          issueId: issue.id,
          identifier: issueIdentifier,
          title: issueTitle,
          archived: true
        }
      };
    } catch (error) {
      logger.error('Failed to delete issue:', error);
      const errorMessage = `❌ Failed to delete issue: ${error instanceof Error ? error.message : 'Unknown error'}`;
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