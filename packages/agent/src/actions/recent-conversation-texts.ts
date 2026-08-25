/**
 * Re-exports core's lossless recent-conversation extraction for agent actions.
 * Keeping one implementation prevents grounded replies and context signals from
 * collapsing repeated turns or diverging from the canonical provider-state path.
 */
export {
  recentConversationTexts,
  recentConversationTextsFromState,
} from "@elizaos/core";
