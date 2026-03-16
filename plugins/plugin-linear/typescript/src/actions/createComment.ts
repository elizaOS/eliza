import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { createCommentTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";
import type { CreateCommentParameters } from "../types/index.js";

export const createCommentAction: Action = {
  name: "CREATE_LINEAR_COMMENT",
  description: "Add a comment to a Linear issue",
  similes: [
    "create-linear-comment",
    "add-linear-comment",
    "comment-on-linear-issue",
    "reply-to-linear-issue",
  ],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Comment on ENG-123: This looks good to me",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll add your comment to issue ENG-123.",
          actions: ["CREATE_LINEAR_COMMENT"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Tell the login bug that we need more information from QA",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll add that comment to the login bug issue.",
          actions: ["CREATE_LINEAR_COMMENT"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Reply to COM2-7: Thanks for the update, I'll look into it",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll add your reply to issue COM2-7.",
          actions: ["CREATE_LINEAR_COMMENT"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const apiKey = runtime.getSetting("LINEAR_API_KEY");
    return !!apiKey;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please provide a message with the issue and comment content.";
        await callback?.({
          text: errorMessage,
          source: message.content.source,
        });
        return {
          text: errorMessage,
          success: false,
        };
      }

      let issueId: string;
      let commentBody: string;

      const params = _options?.parameters as CreateCommentParameters | undefined;
      if (params?.issueId && params?.body) {
        issueId = params.issueId;
        commentBody = params.body;
      } else {
        const prompt = createCommentTemplate.replace("{{userMessage}}", content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt,
        });

        if (!response) {
          const issueMatch = content.match(
            /(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)/i
          );
          if (issueMatch) {
            issueId = issueMatch[1];
            commentBody = issueMatch[2].trim();
          } else {
            throw new Error("Could not understand comment request");
          }
        } else {
          try {
            const parsed = JSON.parse(
              response
                .replace(/^```(?:json)?\n?/, "")
                .replace(/\n?```$/, "")
                .trim()
            );

            if (parsed.issueId) {
              issueId = parsed.issueId;
              commentBody = parsed.commentBody;
            } else if (parsed.issueDescription) {
              const filters: { query: string; limit: number; team?: string } = {
                query: parsed.issueDescription,
                limit: 5,
              };

              const defaultTeamKey = runtime.getSetting("LINEAR_DEFAULT_TEAM_KEY") as string;
              if (defaultTeamKey) {
                filters.team = defaultTeamKey;
              }

              const issues = await linearService.searchIssues(filters);

              if (issues.length === 0) {
                const errorMessage = `No issues found matching "${parsed.issueDescription}". Please provide a specific issue ID.`;
                await callback?.({
                  text: errorMessage,
                  source: message.content.source,
                });
                return {
                  text: errorMessage,
                  success: false,
                };
              }

              if (issues.length === 1) {
                issueId = issues[0].identifier;
                commentBody = parsed.commentBody;
              } else {
                const issueList = await Promise.all(
                  issues.map(async (issue, index) => {
                    const state = await issue.state;
                    return `${index + 1}. ${issue.identifier}: ${issue.title} (${state?.name || "No state"})`;
                  })
                );

                const clarifyMessage = `Found multiple issues matching "${parsed.issueDescription}":\n${issueList.join("\n")}\n\nPlease specify which issue to comment on by its ID.`;
                await callback?.({
                  text: clarifyMessage,
                  source: message.content.source,
                });

                return {
                  text: clarifyMessage,
                  success: false,
                  data: {
                    multipleMatches: true,
                    issues: issues.map((i) => ({
                      id: i.id,
                      identifier: i.identifier,
                      title: i.title,
                    })),
                    pendingComment: parsed.commentBody,
                  },
                };
              }
            } else {
              throw new Error("No issue identifier or description found");
            }

            if (parsed.commentType && parsed.commentType !== "note") {
              commentBody = `[${parsed.commentType.toUpperCase()}] ${commentBody}`;
            }
          } catch (parseError) {
            logger.warn("Failed to parse LLM response, falling back to regex:", parseError);
            const issueMatch = content.match(
              /(?:comment on|add.*comment.*to|reply to|tell)\s+(\w+-\d+):?\s*(.*)/i
            );

            if (!issueMatch) {
              const errorMessage =
                'Please specify the issue ID and comment content. Example: "Comment on ENG-123: This looks good"';
              await callback?.({
                text: errorMessage,
                source: message.content.source,
              });
              return {
                text: errorMessage,
                success: false,
              };
            }

            issueId = issueMatch[1];
            commentBody = issueMatch[2].trim();
          }
        }
      }

      if (!commentBody || commentBody.length === 0) {
        const errorMessage = "Please provide the comment content.";
        await callback?.({
          text: errorMessage,
          source: message.content.source,
        });
        return {
          text: errorMessage,
          success: false,
        };
      }

      const issue = await linearService.getIssue(issueId);

      const comment = await linearService.createComment({
        issueId: issue.id,
        body: commentBody,
      });

      const successMessage = `✅ Comment added to issue ${issue.identifier}: "${commentBody}"`;
      await callback?.({
        text: successMessage,
        source: message.content.source,
      });

      return {
        text: `Added comment to issue ${issue.identifier}`,
        success: true,
        data: {
          commentId: comment.id,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          commentBody: commentBody,
          createdAt:
            comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
        },
      };
    } catch (error) {
      logger.error("Failed to create comment:", error);
      const errorMessage = `❌ Failed to create comment: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
