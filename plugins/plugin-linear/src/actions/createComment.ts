import { Action, ActionResult, IAgentRuntime, Memory, State, logger, HandlerCallback, ModelType } from '@elizaos/core';
import { LinearService } from '../services/linear';
import type { LinearCommentInput } from '../types';

const createCommentTemplate = `Extract comment details from the user's request to add a comment to a Linear issue.

User request: "{{userMessage}}"

The user might express this in various ways:
- "Comment on ENG-123: This looks good"
- "Tell ENG-123 that the fix is ready for testing"
- "Add a note to the login bug saying we need more info"
- "Reply to COM2-7: Thanks for the update"
- "Let the payment issue know that it's blocked by API changes"

Return ONLY a JSON object:
{
  "issueId": "Direct issue ID if explicitly mentioned (e.g., ENG-123)",
  "issueDescription": "Description/keywords of the issue if no ID provided",
  "commentBody": "The actual comment content to add",
  "commentType": "note/reply/update/question/feedback (inferred from context)"
}

Extract the core message the user wants to convey as the comment body.`;

export const createCommentAction: Action = {
  name: 'CREATE_LINEAR_COMMENT',
  description: 'Add a comment to a Linear issue',
  similes: ['create-linear-comment', 'add-linear-comment', 'comment-on-linear-issue', 'reply-to-linear-issue'],
  
  examples: [[
    {
      name: 'User',
      content: {
        text: 'Comment on ENG-123: This looks good to me'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll add your comment to issue ENG-123.',
        actions: ['CREATE_LINEAR_COMMENT']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Tell the login bug that we need more information from QA'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll add that comment to the login bug issue.',
        actions: ['CREATE_LINEAR_COMMENT']
      }
    }
  ], [
    {
      name: 'User',
      content: {
        text: 'Reply to COM2-7: Thanks for the update, I\'ll look into it'
      }
    },
    {
      name: 'Assistant',
      content: {
        text: 'I\'ll add your reply to issue COM2-7.',
        actions: ['CREATE_LINEAR_COMMENT']
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
        const errorMessage = 'Please provide a message with the issue and comment content.';
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
      let commentBody: string;
      
      // Check if we have explicit options
      if (_options?.issueId && _options?.body) {
        issueId = _options.issueId as string;
        commentBody = _options.body as string;
      } else {
        // Use LLM to extract comment information
        const prompt = createCommentTemplate.replace('{{userMessage}}', content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt
        });
        
        if (!response) {
          // Fallback to regex
          const issueMatch = content.match(/(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)/i);
          if (issueMatch) {
            issueId = issueMatch[1];
            commentBody = issueMatch[2].trim();
          } else {
            throw new Error('Could not understand comment request');
          }
        } else {
          try {
            const parsed = JSON.parse(response.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim());
            
            if (parsed.issueId) {
              issueId = parsed.issueId;
              commentBody = parsed.commentBody;
            } else if (parsed.issueDescription) {
              // Search for the issue by description
              const filters: any = {
                query: parsed.issueDescription,
                limit: 5
              };
              
              // Apply default team if configured
              const defaultTeamKey = runtime.getSetting('LINEAR_DEFAULT_TEAM_KEY') as string;
              if (defaultTeamKey) {
                filters.team = defaultTeamKey;
              }
              
              const issues = await linearService.searchIssues(filters);
              
              if (issues.length === 0) {
                const errorMessage = `No issues found matching "${parsed.issueDescription}". Please provide a specific issue ID.`;
                await callback?.({
                  text: errorMessage,
                  source: message.content.source
                });
                return {
                  text: errorMessage,
                  success: false
                };
              }
              
              if (issues.length === 1) {
                issueId = issues[0].identifier;
                commentBody = parsed.commentBody;
              } else {
                // Multiple matches - ask for clarification
                const issueList = await Promise.all(issues.map(async (issue, index) => {
                  const state = await issue.state;
                  return `${index + 1}. ${issue.identifier}: ${issue.title} (${state?.name || 'No state'})`;
                }));
                
                const clarifyMessage = `Found multiple issues matching "${parsed.issueDescription}":\n${issueList.join('\n')}\n\nPlease specify which issue to comment on by its ID.`;
                await callback?.({
                  text: clarifyMessage,
                  source: message.content.source
                });
                
                return {
                  text: clarifyMessage,
                  success: false,
                  data: {
                    multipleMatches: true,
                    issues: issues.map(i => ({
                      id: i.id,
                      identifier: i.identifier,
                      title: i.title
                    })),
                    pendingComment: parsed.commentBody
                  }
                };
              }
            } else {
              throw new Error('No issue identifier or description found');
            }
            
            // Add comment type context if provided
            if (parsed.commentType && parsed.commentType !== 'note') {
              commentBody = `[${parsed.commentType.toUpperCase()}] ${commentBody}`;
            }
            
          } catch (parseError) {
            // Fallback to regex
            logger.warn('Failed to parse LLM response, falling back to regex:', parseError);
            const issueMatch = content.match(/(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)/i);
            
            if (!issueMatch) {
              const errorMessage = 'Please specify the issue ID and comment content. Example: "Comment on ENG-123: This looks good"';
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
            commentBody = issueMatch[2].trim();
          }
        }
      }
      
      if (!commentBody || commentBody.length === 0) {
        const errorMessage = 'Please provide the comment content.';
        await callback?.({
          text: errorMessage,
          source: message.content.source
        });
        return {
          text: errorMessage,
          success: false
        };
      }
      
      // Find the issue first to get its internal ID
      const issue = await linearService.getIssue(issueId);
      
      // Create the comment
      const comment = await linearService.createComment({
        issueId: issue.id,
        body: commentBody
      });
      
      const successMessage = `✅ Comment added to issue ${issue.identifier}: "${commentBody}"`;
      await callback?.({
        text: successMessage,
        source: message.content.source
      });
      
      return {
        text: `Added comment to issue ${issue.identifier}`,
        success: true,
        data: {
          commentId: comment.id,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          commentBody: commentBody,
          createdAt: comment.createdAt
        }
      };
    } catch (error) {
      logger.error('Failed to create comment:', error);
      const errorMessage = `❌ Failed to create comment: ${error instanceof Error ? error.message : 'Unknown error'}`;
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