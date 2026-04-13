import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    entityId: v.string(),
  }).index("by_conversation", ["conversationId"]),

  conversations: defineTable({
    title: v.optional(v.string()),
    agentName: v.string(),
    lastMessageAt: v.optional(v.number()),
  }),
});
