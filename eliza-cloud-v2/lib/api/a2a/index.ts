/**
 * A2A (Agent-to-Agent) Protocol Library
 *
 * Exports all A2A functionality for use in API routes.
 */

// Types
export * from "./types";

// Skills
export {
  executeSkillChatCompletion,
  executeSkillImageGeneration,
  executeSkillCheckBalance,
  executeSkillGetUsage,
  executeSkillListAgents,
  executeSkillChatWithAgent,
  executeSkillSaveMemory,
  executeSkillRetrieveMemories,
  executeSkillCreateConversation,
  executeSkillListContainers,
  executeSkillDeleteMemory,
  executeSkillGetConversationContext,
  executeSkillVideoGeneration,
  executeSkillGetUserProfile,
} from "./skills";

// Handlers
export {
  handleMessageSend,
  handleTasksGet,
  handleTasksCancel,
  AVAILABLE_SKILLS,
} from "./handlers";
