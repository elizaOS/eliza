import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Enum for group types
export const groupTypeEnum = pgEnum("group_type", ["user", "npc", "agent"]);

// Enum for message types
export const messageTypeEnum = pgEnum("message_type", ["user", "system"]);

// Chat
export const chats = pgTable(
  "Chat",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    description: text("description"),
    isGroup: boolean("isGroup").notNull().default(false),
    createdBy: text("createdBy"),
    gameId: text("gameId"),
    dayNumber: integer("dayNumber"),
    relatedQuestion: integer("relatedQuestion"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    groupId: text("groupId"),
    requiredNftContractAddress: text("requiredNftContractAddress"),
    requiredNftTokenId: integer("requiredNftTokenId"),
    requiredNftChainId: integer("requiredNftChainId"),
    nftGated: boolean("nftGated").notNull().default(false),
    lastNftRevalidatedAt: timestamp("lastNftRevalidatedAt", { mode: "date" }),
  },
  (table) => [
    index("Chat_gameId_dayNumber_idx").on(table.gameId, table.dayNumber),
    index("Chat_groupId_idx").on(table.groupId),
    index("Chat_isGroup_idx").on(table.isGroup),
    index("Chat_createdBy_idx").on(table.createdBy),
    index("Chat_relatedQuestion_idx").on(table.relatedQuestion),
    index("Chat_nftGated_idx").on(table.nftGated),
    index("Chat_requiredNftContractAddress_idx").on(
      table.requiredNftContractAddress,
    ),
  ],
);

// ChatParticipant - low-level messaging access
export const chatParticipants = pgTable(
  "ChatParticipant",
  {
    id: text("id").primaryKey(),
    chatId: text("chatId").notNull(),
    userId: text("userId").notNull(),
    joinedAt: timestamp("joinedAt", { mode: "date" }).notNull().defaultNow(),
    invitedBy: text("invitedBy"),
    isActive: boolean("isActive").notNull().default(true),
    addedBy: text("addedBy"),
  },
  (table) => [
    unique("ChatParticipant_chatId_userId_key").on(table.chatId, table.userId),
    index("ChatParticipant_chatId_idx").on(table.chatId),
    index("ChatParticipant_userId_idx").on(table.userId),
    index("ChatParticipant_chatId_isActive_idx").on(
      table.chatId,
      table.isActive,
    ),
    index("ChatParticipant_userId_isActive_idx").on(
      table.userId,
      table.isActive,
    ),
  ],
);

// Message
export const messages = pgTable(
  "Message",
  {
    id: text("id").primaryKey(),
    chatId: text("chatId").notNull(),
    senderId: text("senderId").notNull(),
    content: text("content").notNull(),
    type: messageTypeEnum("type").notNull().default("user"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("Message_chatId_createdAt_idx").on(table.chatId, table.createdAt),
    index("Message_senderId_idx").on(table.senderId),
    index("Message_type_idx").on(table.type),
  ],
);

// DMAcceptance
export const dmAcceptances = pgTable(
  "DMAcceptance",
  {
    id: text("id").primaryKey(),
    chatId: text("chatId").notNull().unique(),
    userId: text("userId").notNull(),
    otherUserId: text("otherUserId").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    acceptedAt: timestamp("acceptedAt", { mode: "date" }),
    rejectedAt: timestamp("rejectedAt", { mode: "date" }),
  },
  (table) => [
    index("DMAcceptance_status_createdAt_idx").on(
      table.status,
      table.createdAt,
    ),
    index("DMAcceptance_userId_status_idx").on(table.userId, table.status),
  ],
);

// Notification
export const notifications = pgTable(
  "Notification",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    type: text("type").notNull(),
    actorId: text("actorId"),
    postId: text("postId"),
    commentId: text("commentId"),
    chatId: text("chatId"),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    title: text("title").notNull(),
    groupId: text("groupId"),
    inviteId: text("inviteId"),
  },
  (table) => [
    index("Notification_chatId_idx").on(table.chatId),
    index("Notification_groupId_idx").on(table.groupId),
    index("Notification_inviteId_idx").on(table.inviteId),
    index("Notification_read_idx").on(table.read),
    index("Notification_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("Notification_userId_read_createdAt_idx").on(
      table.userId,
      table.read,
      table.createdAt,
    ),
    index("Notification_userId_type_read_idx").on(
      table.userId,
      table.type,
      table.read,
    ),
  ],
);

// ============================================================================
// GROUP SYSTEM
// ============================================================================

/**
 * Group table for all group types
 * Supports: user-created groups, NPC-managed groups, agent-created groups
 *
 * Relationship: Chat.groupId → Group.id (one Chat per Group)
 *
 * Tiered System (NPC groups only):
 * - Tier 1 (Inner Circle): 12 members, full alpha
 * - Tier 2 (Community): 50 members, partial alpha
 * - Tier 3 (Followers): 500 members, public content
 */
export const groups = pgTable(
  "Group",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    type: groupTypeEnum("type").notNull(),
    ownerId: text("ownerId").notNull(), // user/NPC/agent who controls it
    createdById: text("createdById").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    // Tiered group system fields (NPC groups only)
    tier: integer("tier"), // 1 = Inner Circle, 2 = Community, 3 = Followers (null for user/agent groups)
    maxMembers: integer("maxMembers"), // Tier-specific member limit (null uses default)
    parentGroupId: text("parentGroupId"), // Links tier groups to same NPC's group family
  },
  (table) => [
    index("Group_type_idx").on(table.type),
    index("Group_ownerId_idx").on(table.ownerId),
    index("Group_createdById_idx").on(table.createdById),
    index("Group_createdAt_idx").on(table.createdAt),
    index("Group_tier_idx").on(table.tier),
    index("Group_ownerId_tier_idx").on(table.ownerId, table.tier),
    index("Group_parentGroupId_idx").on(table.parentGroupId),
  ],
);

/**
 * GroupMember - membership table with roles and quality tracking
 *
 * Unique constraint: Full unique constraint on (groupId, userId).
 * This enables idempotent upserts via onConflictDoUpdate.
 * Soft deletes use the isActive flag (no multiple inactive history rows).
 */
export const groupMembers = pgTable(
  "GroupMember",
  {
    id: text("id").primaryKey(),
    groupId: text("groupId").notNull(),
    userId: text("userId").notNull(),
    // 'owner' = creator/controller of the group
    // 'admin' = can manage members
    // 'member' = regular participant
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joinedAt", { mode: "date" }).notNull().defaultNow(),
    addedBy: text("addedBy"),
    isActive: boolean("isActive").notNull().default(true),
    // Quality tracking (used for NPC groups' kick mechanics)
    lastMessageAt: timestamp("lastMessageAt", { mode: "date" }),
    messageCount: integer("messageCount").notNull().default(0),
    qualityScore: doublePrecision("qualityScore").notNull().default(1.0),
    // Kick tracking
    kickedAt: timestamp("kickedAt", { mode: "date" }),
    kickReason: text("kickReason"),
    // Tiered group system fields (for promotion/demotion tracking)
    tier: integer("tier"), // Mirrors Group.tier for query efficiency
    promotedAt: timestamp("promotedAt", { mode: "date" }),
    demotedAt: timestamp("demotedAt", { mode: "date" }),
    previousTier: integer("previousTier"),
  },
  (table) => [
    // Full unique constraint on (groupId, userId) required for onConflictDoUpdate upserts
    // Note: This replaced the partial index approach - we now use isActive flag for soft deletes
    unique("GroupMember_groupId_userId_key").on(table.groupId, table.userId),
    index("GroupMember_groupId_idx").on(table.groupId),
    index("GroupMember_userId_idx").on(table.userId),
    index("GroupMember_groupId_isActive_idx").on(table.groupId, table.isActive),
    index("GroupMember_userId_isActive_idx").on(table.userId, table.isActive),
    index("GroupMember_lastMessageAt_idx").on(table.lastMessageAt),
    index("GroupMember_role_idx").on(table.role),
    index("GroupMember_tier_idx").on(table.tier),
    // Composite indexes for tier queries (added for PR #670 fixes)
    index("GroupMember_userId_isActive_tier_idx").on(
      table.userId,
      table.isActive,
      table.tier,
    ),
    index("GroupMember_isActive_tier_idx").on(table.isActive, table.tier),
  ],
);

/**
 * GroupInvite - invite system
 */
export const groupInvites = pgTable(
  "GroupInvite",
  {
    id: text("id").primaryKey(),
    groupId: text("groupId").notNull(),
    invitedUserId: text("invitedUserId").notNull(),
    invitedBy: text("invitedBy").notNull(),
    // 'pending' | 'accepted' | 'declined'
    status: text("status").notNull().default("pending"),
    message: text("message"),
    invitedAt: timestamp("invitedAt", { mode: "date" }).notNull().defaultNow(),
    respondedAt: timestamp("respondedAt", { mode: "date" }),
  },
  (table) => [
    unique("GroupInvite_groupId_invitedUserId_key").on(
      table.groupId,
      table.invitedUserId,
    ),
    index("GroupInvite_groupId_idx").on(table.groupId),
    index("GroupInvite_invitedUserId_status_idx").on(
      table.invitedUserId,
      table.status,
    ),
    index("GroupInvite_status_idx").on(table.status),
  ],
);

// ============================================================================
// USER AGENT TEAM CHAT (Command Center)
// ============================================================================

/**
 * UserAgentTeamChat - Links users to their agent "Command Center"
 *
 * Each user has exactly ONE team chat containing all their agents.
 * The team chat is auto-created when the user creates their first agent.
 * Agents are automatically added/removed as they are created/deleted.
 *
 * Relationship:
 * - userId is UNIQUE (one team chat per user)
 * - groupId links to Group (type='agent')
 * - chatId links to Chat (quick access, denormalized for performance)
 */
export const userAgentTeamChats = pgTable(
  "UserAgentTeamChat",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().unique(), // Human user who owns the agents
    groupId: text("groupId").notNull().unique(), // Links to Group (1:1)
    chatId: text("chatId").notNull().unique(), // Links to Chat (1:1)
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    // userId, groupId, chatId already have unique indexes from .unique() constraints
    index("UserAgentTeamChat_groupId_idx").on(table.groupId),
    index("UserAgentTeamChat_chatId_idx").on(table.chatId),
  ],
);

// ============================================================================
// RELATIONS
// ============================================================================

export const userAgentTeamChatsRelations = relations(
  userAgentTeamChats,
  ({ one }) => ({
    group: one(groups, {
      fields: [userAgentTeamChats.groupId],
      references: [groups.id],
    }),
    chat: one(chats, {
      fields: [userAgentTeamChats.chatId],
      references: [chats.id],
    }),
  }),
);

export const chatsRelations = relations(chats, ({ one, many }) => ({
  ChatParticipant: many(chatParticipants),
  Message: many(messages),
  group: one(groups, {
    fields: [chats.groupId],
    references: [groups.id],
  }),
}));

export const chatParticipantsRelations = relations(
  chatParticipants,
  ({ one }) => ({
    chat: one(chats, {
      fields: [chatParticipants.chatId],
      references: [chats.id],
    }),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

export const groupsRelations = relations(groups, ({ many }) => ({
  chats: many(chats),
  members: many(groupMembers),
  invites: many(groupInvites),
}));

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, {
    fields: [groupMembers.groupId],
    references: [groups.id],
  }),
}));

export const groupInvitesRelations = relations(groupInvites, ({ one }) => ({
  group: one(groups, {
    fields: [groupInvites.groupId],
    references: [groups.id],
  }),
}));

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatParticipant = typeof chatParticipants.$inferSelect;
export type NewChatParticipant = typeof chatParticipants.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type DMAcceptance = typeof dmAcceptances.$inferSelect;
export type NewDMAcceptance = typeof dmAcceptances.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// Group types
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
export type GroupInvite = typeof groupInvites.$inferSelect;
export type NewGroupInvite = typeof groupInvites.$inferInsert;

// User agent team chat types
export type UserAgentTeamChat = typeof userAgentTeamChats.$inferSelect;
export type NewUserAgentTeamChat = typeof userAgentTeamChats.$inferInsert;

// Type enums (for type safety)
export type GroupType = "user" | "npc" | "agent";
export type GroupMemberRole = "owner" | "admin" | "member";
export type GroupInviteStatus = "pending" | "accepted" | "declined";
export type MessageType = "user" | "system";
// TierLevel is exported from @polyagent/shared - use that canonical definition
