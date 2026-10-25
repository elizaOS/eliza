/**
 * A2A (Agent-to-Agent) Protocol Library
 *
 * Exports all A2A functionality for use in API routes.
 */

// Handlers
export {
  AVAILABLE_SKILLS,
  handleMessageSend,
  handleTasksCancel,
  handleTasksGet,
} from "./handlers";

// Skills
export {
  executeSkillChatCompletion,
  executeSkillChatWithAgent,
  executeSkillCheckBalance,
  executeSkillCreateConversation,
  executeSkillDeleteMemory,
  executeSkillGetConversationContext,
  executeSkillGetUsage,
  executeSkillGetUserProfile,
  executeSkillImageGeneration,
  executeSkillListAgents,
  executeSkillListContainers,
  executeSkillRetrieveMemories,
  executeSkillSaveMemory,
  executeSkillVideoGeneration,
} from "./skills";
// Types
export * from "./types";
