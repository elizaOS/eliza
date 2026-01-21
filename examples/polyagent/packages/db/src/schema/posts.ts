import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users";

// Post
export const posts = pgTable(
  "Post",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    authorId: text("authorId").notNull(),
    gameId: text("gameId"),
    dayNumber: integer("dayNumber"),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    articleTitle: text("articleTitle"),
    biasScore: doublePrecision("biasScore"),
    byline: text("byline"),
    category: text("category"),
    fullContent: text("fullContent"),
    sentiment: text("sentiment"),
    slant: text("slant"),
    imageUrl: text("imageUrl"),
    type: text("type").notNull().default("post"),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    commentOnPostId: text("commentOnPostId"),
    parentCommentId: text("parentCommentId"),
    originalPostId: text("originalPostId"),
    /** Related question number for training data filtering */
    relatedQuestion: integer("relatedQuestion"),
  },
  (table) => [
    index("Post_authorId_timestamp_idx").on(table.authorId, table.timestamp),
    index("Post_authorId_type_timestamp_idx").on(
      table.authorId,
      table.type,
      table.timestamp,
    ),
    index("Post_commentOnPostId_idx").on(table.commentOnPostId),
    index("Post_deletedAt_idx").on(table.deletedAt),
    index("Post_gameId_dayNumber_idx").on(table.gameId, table.dayNumber),
    index("Post_parentCommentId_idx").on(table.parentCommentId),
    index("Post_originalPostId_idx").on(table.originalPostId),
    index("Post_timestamp_idx").on(table.timestamp),
    index("Post_type_deletedAt_timestamp_idx").on(
      table.type,
      table.deletedAt,
      table.timestamp,
    ),
    index("Post_type_timestamp_idx").on(table.type, table.timestamp),
    index("Post_relatedQuestion_idx").on(table.relatedQuestion),
  ],
);

// Comment
export const comments = pgTable(
  "Comment",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    postId: text("postId").notNull(),
    authorId: text("authorId").notNull(),
    parentCommentId: text("parentCommentId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    index("Comment_authorId_idx").on(table.authorId),
    index("Comment_deletedAt_idx").on(table.deletedAt),
    index("Comment_parentCommentId_idx").on(table.parentCommentId),
    index("Comment_postId_createdAt_idx").on(table.postId, table.createdAt),
    index("Comment_postId_deletedAt_idx").on(table.postId, table.deletedAt),
  ],
);

// Reaction
export const reactions = pgTable(
  "Reaction",
  {
    id: text("id").primaryKey(),
    postId: text("postId"),
    commentId: text("commentId"),
    userId: text("userId").notNull(),
    type: text("type").notNull().default("like"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("Reaction_commentId_userId_type_key").on(
      table.commentId,
      table.userId,
      table.type,
    ),
    unique("Reaction_postId_userId_type_key").on(
      table.postId,
      table.userId,
      table.type,
    ),
    index("Reaction_commentId_idx").on(table.commentId),
    index("Reaction_postId_idx").on(table.postId),
    index("Reaction_userId_idx").on(table.userId),
  ],
);

// Share
export const shares = pgTable(
  "Share",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    postId: text("postId").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("Share_userId_postId_key").on(table.userId, table.postId),
    index("Share_createdAt_idx").on(table.createdAt),
    index("Share_postId_idx").on(table.postId),
    index("Share_userId_idx").on(table.userId),
  ],
);

// ShareAction
export const shareActions = pgTable(
  "ShareAction",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    platform: text("platform").notNull(),
    contentType: text("contentType").notNull(),
    contentId: text("contentId"),
    url: text("url"),
    pointsAwarded: boolean("pointsAwarded").notNull().default(false),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    verificationDetails: text("verificationDetails"),
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verifiedAt", { mode: "date" }),
  },
  (table) => [
    index("ShareAction_contentType_idx").on(table.contentType),
    index("ShareAction_platform_idx").on(table.platform),
    index("ShareAction_userId_createdAt_idx").on(table.userId, table.createdAt),
    index("ShareAction_verified_idx").on(table.verified),
  ],
);

// Tag
export const tags = pgTable(
  "Tag",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    displayName: text("displayName").notNull(),
    category: text("category"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [index("Tag_name_idx").on(table.name)],
);

// PostTag
export const postTags = pgTable(
  "PostTag",
  {
    id: text("id").primaryKey(),
    postId: text("postId").notNull(),
    tagId: text("tagId").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("PostTag_postId_tagId_key").on(table.postId, table.tagId),
    index("PostTag_postId_idx").on(table.postId),
    index("PostTag_tagId_createdAt_idx").on(table.tagId, table.createdAt),
    index("PostTag_tagId_idx").on(table.tagId),
  ],
);

// TrendingTag
export const trendingTags = pgTable(
  "TrendingTag",
  {
    id: text("id").primaryKey(),
    tagId: text("tagId").notNull(),
    score: doublePrecision("score").notNull(),
    postCount: integer("postCount").notNull(),
    rank: integer("rank").notNull(),
    calculatedAt: timestamp("calculatedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    windowStart: timestamp("windowStart", { mode: "date" }).notNull(),
    windowEnd: timestamp("windowEnd", { mode: "date" }).notNull(),
    relatedContext: text("relatedContext"),
  },
  (table) => [
    index("TrendingTag_calculatedAt_idx").on(table.calculatedAt),
    index("TrendingTag_rank_calculatedAt_idx").on(
      table.rank,
      table.calculatedAt,
    ),
    index("TrendingTag_tagId_calculatedAt_idx").on(
      table.tagId,
      table.calculatedAt,
    ),
  ],
);

// Relations
export const postsRelations = relations(posts, ({ one, many }) => ({
  User: one(users, {
    fields: [posts.authorId],
    references: [users.id],
  }),
  Post_commentOnPostIdToPost: one(posts, {
    fields: [posts.commentOnPostId],
    references: [posts.id],
    relationName: "Post_commentOnPostIdToPost",
  }),
  other_Post_commentOnPostIdToPost: many(posts, {
    relationName: "Post_commentOnPostIdToPost",
  }),
  Post_parentCommentIdToPost: one(posts, {
    fields: [posts.parentCommentId],
    references: [posts.id],
    relationName: "Post_parentCommentIdToPost",
  }),
  other_Post_parentCommentIdToPost: many(posts, {
    relationName: "Post_parentCommentIdToPost",
  }),
  Post_originalPostIdToPost: one(posts, {
    fields: [posts.originalPostId],
    references: [posts.id],
    relationName: "Post_originalPostIdToPost",
  }),
  other_Post_originalPostIdToPost: many(posts, {
    relationName: "Post_originalPostIdToPost",
  }),
  Comment: many(comments),
  Reaction: many(reactions),
  Share: many(shares),
  PostTag: many(postTags),
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  author: one(users, {
    fields: [comments.authorId],
    references: [users.id],
  }),
  post: one(posts, {
    fields: [comments.postId],
    references: [posts.id],
  }),
  parentComment: one(comments, {
    fields: [comments.parentCommentId],
    references: [comments.id],
    relationName: "CommentToComment",
  }),
  childComments: many(comments, {
    relationName: "CommentToComment",
  }),
  reactions: many(reactions),
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  post: one(posts, {
    fields: [reactions.postId],
    references: [posts.id],
  }),
  comment: one(comments, {
    fields: [reactions.commentId],
    references: [comments.id],
  }),
  user: one(users, {
    fields: [reactions.userId],
    references: [users.id],
  }),
}));

export const sharesRelations = relations(shares, ({ one }) => ({
  post: one(posts, {
    fields: [shares.postId],
    references: [posts.id],
  }),
  user: one(users, {
    fields: [shares.userId],
    references: [users.id],
  }),
}));

export const shareActionsRelations = relations(shareActions, ({ one }) => ({
  user: one(users, {
    fields: [shareActions.userId],
    references: [users.id],
  }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
  trendingTags: many(trendingTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, {
    fields: [postTags.postId],
    references: [posts.id],
  }),
  tag: one(tags, {
    fields: [postTags.tagId],
    references: [tags.id],
  }),
}));

export const trendingTagsRelations = relations(trendingTags, ({ one }) => ({
  tag: one(tags, {
    fields: [trendingTags.tagId],
    references: [tags.id],
  }),
}));

// Type exports
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
export type NewReaction = typeof reactions.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type ShareAction = typeof shareActions.$inferSelect;
export type NewShareAction = typeof shareActions.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type PostTag = typeof postTags.$inferSelect;
export type NewPostTag = typeof postTags.$inferInsert;
export type TrendingTag = typeof trendingTags.$inferSelect;
export type NewTrendingTag = typeof trendingTags.$inferInsert;
