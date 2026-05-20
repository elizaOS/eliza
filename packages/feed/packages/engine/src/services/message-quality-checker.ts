/**
 * Message Quality Checker Service
 *
 * @description Validates message quality based on length, uniqueness, and content
 * quality. Returns a quality score (0-1) that affects following chances, group
 * chat invite chances, and risk of being booted from group chats.
 */

import {
  comments,
  db,
  desc,
  eq,
  messages,
  userInteractions,
} from '@babylon/db';

/**
 * Message quality check result
 */
export interface QualityCheckResult {
  score: number; // 0-1, where 1 is perfect
  passed: boolean; // Whether message meets minimum standards
  warnings: string[]; // Non-blocking issues
  errors: string[]; // Blocking issues
  factors: {
    length: number; // 0-1
    uniqueness: number; // 0-1
    contentQuality: number; // 0-1
  };
}

/**
 * Message Quality Checker Class
 */
export class MessageQualityChecker {
  private static readonly MIN_LENGTH = 1;
  private static readonly IDEAL_MIN_LENGTH = 30;
  private static readonly IDEAL_MAX_LENGTH = 200;
  private static readonly MAX_LENGTH = 500;
  private static readonly DUPLICATE_THRESHOLD = 0.85;

  /**
   * Check message quality
   */
  static async checkQuality(
    message: string,
    userId: string,
    contextType: 'reply' | 'groupchat' | 'dm',
    contextId: string
  ): Promise<QualityCheckResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Check length
    const lengthScore = MessageQualityChecker.checkLength(
      message,
      contextType,
      errors,
      warnings
    );

    // 2. Check for duplicates
    const uniquenessScore = await MessageQualityChecker.checkUniqueness(
      message,
      userId,
      contextType,
      contextId,
      errors,
      warnings
    );

    // 3. Check content quality
    const contentScore = MessageQualityChecker.checkContent(
      message,
      contextType,
      errors,
      warnings
    );

    // Calculate overall score (weighted average)
    const score =
      lengthScore * 0.3 + uniquenessScore * 0.4 + contentScore * 0.3;

    return {
      score,
      passed: errors.length === 0 && score >= 0.5,
      warnings,
      errors,
      factors: {
        length: lengthScore,
        uniqueness: uniquenessScore,
        contentQuality: contentScore,
      },
    };
  }

  /**
   * Check message length
   */
  private static checkLength(
    message: string,
    contextType: 'reply' | 'groupchat' | 'dm',
    errors: string[],
    warnings: string[]
  ): number {
    const length = message.trim().length;

    if (length < MessageQualityChecker.MIN_LENGTH) {
      errors.push('Message cannot be empty');
      return 0;
    }

    if (length > MessageQualityChecker.MAX_LENGTH) {
      errors.push(
        `Message too long (max ${MessageQualityChecker.MAX_LENGTH} characters)`
      );
      return 0;
    }

    // DMs: allow any non-empty length without soft warnings
    if (contextType === 'dm') {
      return 1.0;
    }

    if (length < MessageQualityChecker.IDEAL_MIN_LENGTH) {
      warnings.push('Message is short (still allowed)');
      return 0.6;
    }

    if (length > MessageQualityChecker.IDEAL_MAX_LENGTH) {
      warnings.push('Message is a bit long for best quality score');
      return 0.8;
    }

    // Perfect length
    return 1.0;
  }

  /**
   * Check for duplicate/similar messages
   */
  private static async checkUniqueness(
    message: string,
    userId: string,
    contextType: 'reply' | 'groupchat' | 'dm',
    contextId: string,
    errors: string[],
    warnings: string[]
  ): Promise<number> {
    // Skip uniqueness check for game chats (empty contextId)
    if (!contextId) {
      return 1.0;
    }

    // Get recent messages from this user
    let recentMessages: string[] = [];

    if (contextType === 'reply') {
      // Check comments from this user on any post
      const recentComments = await db
        .select({ content: comments.content })
        .from(comments)
        .where(eq(comments.authorId, userId))
        .orderBy(desc(comments.createdAt))
        .limit(20);
      recentMessages = recentComments.map((c) => c.content);
    } else if (contextType === 'dm' || contextType === 'groupchat') {
      // Check messages from this user in this chat
      const recentChatMessages = await db
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.senderId, userId))
        .orderBy(desc(messages.createdAt))
        .limit(20);
      recentMessages = recentChatMessages.map((m) => m.content);
    }

    // Check similarity with recent messages
    const normalizedMessage = MessageQualityChecker.normalizeText(message);
    let highestSimilarity = 0;

    for (const recentMessage of recentMessages) {
      const similarity = MessageQualityChecker.calculateSimilarity(
        normalizedMessage,
        MessageQualityChecker.normalizeText(recentMessage)
      );
      highestSimilarity = Math.max(highestSimilarity, similarity);

      if (similarity >= MessageQualityChecker.DUPLICATE_THRESHOLD) {
        errors.push('Message is too similar to a recent message you posted');
        return 0;
      }
    }

    if (highestSimilarity > 0.7) {
      warnings.push('Message is somewhat similar to a recent message');
      return 0.7;
    }

    return 1.0;
  }

  /**
   * Check content quality
   */
  private static checkContent(
    message: string,
    contextType: 'reply' | 'groupchat' | 'dm',
    errors: string[],
    warnings: string[]
  ): number {
    const trimmed = message.trim();

    // Check for all caps (spam indicator)
    const capsRatio = (trimmed.match(/[A-Z]/g) || []).length / trimmed.length;
    if (capsRatio > 0.7 && trimmed.length > 20) {
      warnings.push('Excessive caps usage may lower quality score');
      return 0.6;
    }

    // Check for repeated characters (spammy)
    if (/(.)\1{4,}/.test(trimmed)) {
      warnings.push('Repeated characters detected');
      return 0.7;
    }

    // Check for excessive punctuation
    const punctuationRatio =
      (trimmed.match(/[!?.,;:]/g) || []).length / trimmed.length;
    if (punctuationRatio > 0.3) {
      warnings.push('Excessive punctuation usage');
      return 0.7;
    }

    // Skip word-count softness for DMs
    if (contextType !== 'dm') {
      const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
      if (words.length < 3) {
        warnings.push('Message has very few words (still allowed)');
        return 0.6;
      }
    }

    // Check for URL spam (multiple URLs)
    const urlCount = (trimmed.match(/https?:\/\//gi) || []).length;
    if (urlCount > 2) {
      errors.push('Too many URLs in message');
      return 0;
    }

    return 1.0;
  }

  /**
   * Normalize text for comparison
   */
  private static normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Calculate similarity between two texts (Jaccard similarity)
   */
  private static calculateSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.split(/\s+/));
    const words2 = new Set(text2.split(/\s+/));

    const intersection = new Set([...words1].filter((w) => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Get user's quality statistics
   */
  static async getUserQualityStats(userId: string) {
    const interactions = await db
      .select({ qualityScore: userInteractions.qualityScore })
      .from(userInteractions)
      .where(eq(userInteractions.userId, userId));

    if (interactions.length === 0) {
      return {
        averageScore: 0,
        totalMessages: 0,
        highQualityCount: 0,
        lowQualityCount: 0,
      };
    }

    const averageScore =
      interactions.reduce((sum, i) => sum + i.qualityScore, 0) /
      interactions.length;
    const highQualityCount = interactions.filter(
      (i) => i.qualityScore >= 0.8
    ).length;
    const lowQualityCount = interactions.filter(
      (i) => i.qualityScore < 0.5
    ).length;

    return {
      averageScore,
      totalMessages: interactions.length,
      highQualityCount,
      lowQualityCount,
    };
  }
}
