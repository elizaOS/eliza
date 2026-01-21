import {
  type Action,
  createUniqueUuid,
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

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    void runtime; // Runtime currently unused during validation

    const text = message.content.text?.toLowerCase();
    return text?.includes("remember") || text?.includes("record") || false;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<void> {
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
        context: state
          ? {
              recentMessages: state.values?.recentMessages,
              entities: state.values?.entities,
              facts: state.values?.facts,
            }
          : undefined,
      },
      createdAt: Date.now(),
    };

    // Store in experiences table
    await runtime.createMemory(experienceMemory, "experiences", true);
    logger.info("Experience recorded successfully");
  },
};
