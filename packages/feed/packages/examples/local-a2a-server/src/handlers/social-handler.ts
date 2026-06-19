/**
 * Social Handler
 * Handles social features: posts, likes, comments, notifications
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

interface Post {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  mediaUrls: string[];
  likesCount: number;
  commentsCount: number;
  repostsCount: number;
  createdAt: string;
  isLikedByUser?: boolean;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

interface User {
  id: string;
  walletAddress: string;
  displayName: string;
  username: string;
  bio: string;
  avatarUrl: string;
}

export class SocialHandler {
  constructor(private db: Database) {}

  /**
   * Get feed posts
   */
  getFeed(params: Record<string, unknown>): { posts: Post[] } {
    const limit = (params.limit as number) || 20;
    const offset = (params.offset as number) || 0;

    const results = this.db
      .query(`
      SELECT 
        p.*,
        u.display_name as author_name,
        u.avatar_url as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.is_deleted = 0 AND p.parent_id IS NULL
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `)
      .all(limit, offset) as Record<string, unknown>[];

    return {
      posts: results.map((row) => this.rowToPost(row)),
    };
  }

  /**
   * Get single post
   */
  getPost(postId: string): Post {
    const row = this.db
      .query(`
      SELECT 
        p.*,
        u.display_name as author_name,
        u.avatar_url as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.id = ?
    `)
      .get(postId) as Record<string, unknown> | null;

    if (!row) {
      throw new Error(`Post not found: ${postId}`);
    }

    return this.rowToPost(row);
  }

  /**
   * Create a new post
   */
  createPost(authorId: string, content: string, mediaUrls?: string[]): Post {
    if (!content || content.trim().length === 0) {
      throw new Error("Post content cannot be empty");
    }

    if (content.length > 500) {
      throw new Error("Post content too long (max 500 characters)");
    }

    const postId = randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `
      INSERT INTO posts (id, author_id, content, media_urls, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      [postId, authorId, content, JSON.stringify(mediaUrls || []), now],
    );

    // Get author info
    const authorRow = this.db
      .query("SELECT display_name FROM users WHERE id = ?")
      .get(authorId) as { display_name: string } | null;

    return {
      id: postId,
      authorId,
      authorName: authorRow?.display_name || "Unknown",
      content,
      mediaUrls: mediaUrls || [],
      likesCount: 0,
      commentsCount: 0,
      repostsCount: 0,
      createdAt: now,
    };
  }

  /**
   * Like a post
   */
  likePost(
    userId: string,
    postId: string,
  ): { success: boolean; likesCount: number } {
    // Check if already liked
    const existing = this.db
      .query("SELECT id FROM likes WHERE user_id = ? AND post_id = ?")
      .get(userId, postId);

    if (existing) {
      // Unlike
      this.db.run(
        "DELETE FROM likes WHERE user_id = ? AND post_id = ?",
        [userId, postId],
      );
      this.db.run(
        "UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?",
        [postId],
      );
    } else {
      // Like
      const likeId = randomUUID();
      this.db.run(
        "INSERT INTO likes (id, user_id, post_id) VALUES (?, ?, ?)",
        [likeId, userId, postId],
      );
      this.db.run(
        "UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?",
        [postId],
      );

      // Create notification for post author
      this.createNotification(postId, userId, "like");
    }

    // Get updated count
    const countRow = this.db
      .query("SELECT likes_count FROM posts WHERE id = ?")
      .get(postId) as { likes_count: number } | null;

    return {
      success: true,
      likesCount: countRow?.likes_count || 0,
    };
  }

  /**
   * Comment on a post
   */
  commentPost(userId: string, postId: string, content: string): Post {
    if (!content || content.trim().length === 0) {
      throw new Error("Comment cannot be empty");
    }

    const commentId = randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `
      INSERT INTO posts (id, author_id, content, parent_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      [commentId, userId, content, postId, now],
    );

    this.db.run(
      "UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?",
      [postId],
    );

    // Create notification
    this.createNotification(postId, userId, "comment");

    // Get author info
    const authorRow = this.db
      .query("SELECT display_name FROM users WHERE id = ?")
      .get(userId) as { display_name: string } | null;

    return {
      id: commentId,
      authorId: userId,
      authorName: authorRow?.display_name || "Unknown",
      content,
      mediaUrls: [],
      likesCount: 0,
      commentsCount: 0,
      repostsCount: 0,
      createdAt: now,
    };
  }

  /**
   * Search users
   */
  searchUsers(query: string): { users: User[] } {
    const results = this.db
      .query(`
      SELECT * FROM users 
      WHERE display_name LIKE ? OR username LIKE ?
      LIMIT 20
    `)
      .all(`%${query}%`, `%${query}%`) as Record<string, unknown>[];

    return {
      users: results.map((row) => ({
        id: row.id as string,
        walletAddress: row.wallet_address as string,
        displayName: row.display_name as string,
        username: row.username as string,
        bio: (row.bio as string) || "",
        avatarUrl: (row.avatar_url as string) || "",
      })),
    };
  }

  /**
   * Get notifications
   */
  getNotifications(
    userId: string,
    params: Record<string, unknown>,
  ): { notifications: Notification[] } {
    const limit = (params.limit as number) || 20;
    const unreadOnly = params.unreadOnly as boolean | undefined;

    let query = "SELECT * FROM notifications WHERE user_id = ?";
    const queryParams: (string | number)[] = [userId];

    if (unreadOnly) {
      query += " AND is_read = 0";
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    queryParams.push(limit);

    const results = this.db.query(query).all(...queryParams) as Record<
      string,
      unknown
    >[];

    return {
      notifications: results.map((row) => ({
        id: row.id as string,
        type: row.type as string,
        title: row.title as string,
        message: (row.message as string) || "",
        data: JSON.parse((row.data as string) || "{}"),
        isRead: Boolean(row.is_read),
        createdAt: row.created_at as string,
      })),
    };
  }

  /**
   * Mark notification as read
   */
  markNotificationRead(
    userId: string,
    notificationId: string,
  ): { success: boolean } {
    this.db.run(
      "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
      [notificationId, userId],
    );

    return { success: true };
  }

  private createNotification(
    postId: string,
    fromUserId: string,
    type: "like" | "comment",
  ): void {
    // Get post author
    const postRow = this.db
      .query("SELECT author_id FROM posts WHERE id = ?")
      .get(postId) as { author_id: string } | null;

    if (!postRow) return;
    const authorId = postRow.author_id;

    // Don't notify yourself
    if (authorId === fromUserId) return;

    // Get from user name
    const userRow = this.db
      .query("SELECT display_name FROM users WHERE id = ?")
      .get(fromUserId) as { display_name: string } | null;

    const fromName = userRow?.display_name || "Someone";

    const notificationId = randomUUID();
    const title = type === "like" ? "New Like" : "New Comment";
    const message =
      type === "like"
        ? `${fromName} liked your post`
        : `${fromName} commented on your post`;

    this.db.run(
      `
      INSERT INTO notifications (id, user_id, type, title, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
        notificationId,
        authorId,
        type,
        title,
        message,
        JSON.stringify({ postId, fromUserId }),
      ],
    );
  }

  /**
   * Get social statistics for system stats
   */
  getSocialStats(): { totalUsers: number; totalPosts: number } {
    const userRow = this.db
      .query("SELECT COUNT(*) as count FROM users WHERE id != ?")
      .get("system") as { count: number };
    const postRow = this.db
      .query("SELECT COUNT(*) as count FROM posts WHERE is_deleted = 0")
      .get() as { count: number };

    return {
      totalUsers: userRow.count,
      totalPosts: postRow.count,
    };
  }

  private rowToPost(row: Record<string, unknown>): Post {
    return {
      id: row.id as string,
      authorId: row.author_id as string,
      authorName: (row.author_name as string) || "Unknown",
      content: row.content as string,
      mediaUrls: JSON.parse((row.media_urls as string) || "[]"),
      likesCount: (row.likes_count as number) || 0,
      commentsCount: (row.comments_count as number) || 0,
      repostsCount: (row.reposts_count as number) || 0,
      createdAt: row.created_at as string,
    };
  }
}
