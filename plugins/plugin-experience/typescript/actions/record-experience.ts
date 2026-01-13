import {
  type Action,
  type ActionResult,
  createUniqueUuid,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";

export const recordExperienceAction: Action = {
  name: "RECORD_EXPERIENCE",
  description: "Manually record a learning experience",

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Remember that installing dependencies is required for Python scripts",
        },
      },
      {
        name: "Agent",
        content: {
          text: "I'll record that experience. Learning: Need to install dependencies before running Python scripts.",
          action: "RECORD_EXPERIENCE",
        },
      },
    ],
  ],

  async validate(_runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content.text?.toLowerCase();
    return text?.includes("remember") || text?.includes("record") || false;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback
  ): Promise<ActionResult> {
    void _options;
    void _callback;

    logger.info("Recording experience for message:", message.id);

    // Create experience memory with context
    const experienceMemory: Memory = {
      id: createUniqueUuid(runtime, `experience-${message.id}`),
      entityId: message.entityId,
      agentId: runtime.agentId,
      roomId: message.roomId,
      content: {
        text: message.content.text,
        source: message.content.source,
        type: "experience",
        context: state?.text,
      },
      createdAt: Date.now(),
    };

    // Store in experiences table
    await runtime.createMemory(experienceMemory, "experiences", true);
    logger.info("Experience recorded successfully");

    return {
      success: true,
      text: "Experience recorded.",
      data: {
        experienceMemoryId: experienceMemory.id,
      },
    };
  },
};
