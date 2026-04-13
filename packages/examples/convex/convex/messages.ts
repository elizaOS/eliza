import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";

/**
 * Store a message in the database.
 * Called internally from the agent action after processing.
 */
export const store = internalMutation({
  args: {
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    entityId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      role: args.role,
      text: args.text,
      entityId: args.entityId,
    });
  },
});

/**
 * List all messages in a conversation, ordered by creation time.
 * Public query — clients can subscribe for real-time updates.
 */
export const list = query({
  args: { conversationId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      _creationTime: v.number(),
      conversationId: v.string(),
      role: v.union(v.literal("user"), v.literal("assistant")),
      text: v.string(),
      entityId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();
  },
});

/**
 * Create a new conversation.
 */
export const createConversation = mutation({
  args: {
    title: v.optional(v.string()),
    agentName: v.optional(v.string()),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("conversations", {
      title: args.title,
      agentName: args.agentName ?? "Eliza",
      lastMessageAt: Date.now(),
    });
  },
});

/**
 * Update the last message timestamp on a conversation.
 */
export const touchConversation = internalMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: Date.now(),
    });
  },
});
