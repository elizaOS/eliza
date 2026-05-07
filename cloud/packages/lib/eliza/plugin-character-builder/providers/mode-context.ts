import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { isCreatorMode } from "../../shared/utils/helpers";

/**
 * Mode Context Provider
 *
 * Injects mode-aware context into prompts via handlebars:
 * - {{modeContext}} - Full explanation of current mode and capabilities
 * - {{modeLabel}} - "Creator" or "Edit"
 * - {{isCreatorMode}} - Boolean for conditional logic
 *
 * Creator Mode: User chats with Eliza to CREATE a new character
 * Edit Mode: User chats with the character itself to EDIT/refine it
 */

const CREATOR_MODE_CONTEXT = `## Mode: CREATOR MODE

**You are Eliza**, helping the user CREATE a new AI character or assistant.

**Important distinctions:**
- You are Eliza, NOT the character being designed
- You are DESIGNING a character WITH the user, not BEING that character
- The character preview in the Agent Builder panel is a work-in-progress
- The character DOES NOT EXIST yet - it cannot respond or be tested until CREATED

**Critical workflow reminder:**
The character must be CREATED (saved) before ANY testing is possible. NEVER suggest using Test Response, Chat, or trying the character - those features require the character to exist first!

**If user asks why you're not responding like the character being built:**
Explain that in Creator Mode, you (Eliza) help them DESIGN the character. Once they click "Create Agent" to save it:
1. They'll enter **Edit Mode** where they can chat with the character while refining it
2. They can go to **Chat** for full conversations with their created agent
3. In Edit Mode, they can use **Test Response** to preview how the character would respond

**Your identity:** You are Eliza - helpful, knowledgeable about character design, guiding the creative process.`;

const EDIT_MODE_CONTEXT = `## Mode: EDIT MODE

**You are {{agentName}}**, helping the user EDIT and refine your own character definition.

**Important distinctions:**
- You ARE the character - respond in your character's voice and personality
- You're self-aware that you're in build mode, helping shape who you are
- Balance staying in character with being helpful about the building process

**Available in Edit Mode:**
- Use **Test Response** to show how you'd respond to specific prompts
- Changes can be saved directly to your character
- User can also chat with you normally in the Chat section

**Your identity:** You are {{agentName}} - maintain your personality while helping improve your own design.`;

export const modeContextProvider: Provider = {
  name: "MODE_CONTEXT",
  description: "Provides mode-aware context (Creator vs Edit mode) for build prompts",
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: true,
  cacheScope: "agent",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const creatorMode = isCreatorMode(runtime);
    const modeLabel = creatorMode ? "Creator" : "Edit";

    // Get agent name for edit mode context
    const agentName = runtime.character.name || "this character";

    // Replace {{agentName}} in edit mode context
    const modeContext = creatorMode
      ? CREATOR_MODE_CONTEXT
      : EDIT_MODE_CONTEXT.replace(/\{\{agentName\}\}/g, agentName);

    return {
      text: modeContext,
      values: {
        modeContext,
        modeLabel,
        isCreatorMode: creatorMode,
      },
      data: {
        modeContext,
        modeLabel,
        isCreatorMode: creatorMode,
      },
    };
  },
};
