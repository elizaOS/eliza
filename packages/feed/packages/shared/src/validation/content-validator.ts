/**
 * Content Validator
 *
 * @description Canonical validation service for all generated content.
 * Consolidates scattered validation logic into fail-fast assertions.
 *
 * Purpose:
 * - Prevent invalid data from propagating through system
 * - Fail immediately with clear errors
 * - Consistent validation across all generators
 * - Replace copy-pasted null checks everywhere
 *
 * Usage:
 * ```typescript
 * // Before:
 * if (!post.content || post.content.trim().length === 0) {
 *   return; // Skip
 * }
 * if (post.content.length > 5000) {
 *   post.content = post.content.substring(0, 5000);
 * }
 *
 * // After:
 * ContentValidator.validatePostContent(post.content);
 * ```
 */

import { logger } from "../utils/logger";

/**
 * Content Validator Class
 *
 * @description Static class providing validation methods for various content
 * types. Uses type assertions to ensure type safety after validation.
 */
export class ContentValidator {
  /**
   * Maximum post content length (5000 characters)
   * @private
   */
  private static readonly MAX_POST_LENGTH = 5000;

  /**
   * Maximum event description length (250 characters)
   * @private
   */
  private static readonly MAX_EVENT_DESCRIPTION = 250;

  /**
   * Maximum question text length (500 characters)
   * @private
   */
  private static readonly MAX_QUESTION_TEXT = 500;

  /**
   * Validate post content
   *
   * @description Validates that post content is a non-empty string within
   * length limits. Throws error if validation fails. Uses type assertion
   * to narrow type after validation.
   *
   * @param {unknown} content - Post content to validate
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If content is null, undefined, empty, or exceeds max length
   *
   * @example
   * ```typescript
   * ContentValidator.validatePostContent(post.content, 'media post');
   * // Throws if empty or too long
   * // After this, TypeScript knows content is string
   * ```
   */
  static validatePostContent(
    content: unknown,
    context?: string,
  ): asserts content is string {
    const ctx = context || "post";

    if (content === null || content === undefined) {
      throw new Error(`${ctx}: content is null or undefined`);
    }

    if (typeof content !== "string") {
      throw new Error(`${ctx}: content must be string, got ${typeof content}`);
    }

    if (content.trim().length === 0) {
      throw new Error(`${ctx}: content cannot be empty`);
    }

    if (content.length > ContentValidator.MAX_POST_LENGTH) {
      logger.warn(
        `${ctx}: content exceeds max length`,
        {
          length: content.length,
          max: ContentValidator.MAX_POST_LENGTH,
        },
        "ContentValidator",
      );
      throw new Error(
        `${ctx}: content exceeds maximum length (${ContentValidator.MAX_POST_LENGTH} chars)`,
      );
    }
  }

  /**
   * Validate event description
   *
   * @description Validates that event description is a non-empty string.
   * Warns but doesn't throw if description exceeds max length (truncation
   * happens later).
   *
   * @param {unknown} description - Event description to validate
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If description is null, undefined, or empty
   */
  static validateEventDescription(
    description: unknown,
    context?: string,
  ): asserts description is string {
    const ctx = context || "event";

    if (description === null || description === undefined) {
      throw new Error(`${ctx}: description is null or undefined`);
    }

    if (typeof description !== "string") {
      throw new Error(
        `${ctx}: description must be string, got ${typeof description}`,
      );
    }

    if (description.trim().length === 0) {
      throw new Error(`${ctx}: description cannot be empty`);
    }

    if (description.length > ContentValidator.MAX_EVENT_DESCRIPTION) {
      logger.warn(
        `${ctx}: description too long, will truncate`,
        {
          length: description.length,
          max: ContentValidator.MAX_EVENT_DESCRIPTION,
        },
        "ContentValidator",
      );
      // Don't throw - just warn (truncation happens later)
    }
  }

  /**
   * Validate question text
   *
   * @description Validates that question text is a non-empty string within
   * length limits. Throws error if validation fails.
   *
   * @param {unknown} text - Question text to validate
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If text is null, undefined, empty, or exceeds max length
   */
  static validateQuestionText(
    text: unknown,
    context?: string,
  ): asserts text is string {
    const ctx = context || "question";

    if (text === null || text === undefined) {
      throw new Error(`${ctx}: text is null or undefined`);
    }

    if (typeof text !== "string") {
      throw new Error(`${ctx}: text must be string, got ${typeof text}`);
    }

    if (text.trim().length === 0) {
      throw new Error(`${ctx}: text cannot be empty`);
    }

    if (text.length > ContentValidator.MAX_QUESTION_TEXT) {
      throw new Error(
        `${ctx}: text exceeds maximum length (${ContentValidator.MAX_QUESTION_TEXT} chars)`,
      );
    }
  }

  /**
   * Validate entity name (actor, organization)
   *
   * @description Validates that entity name is a non-empty string.
   *
   * @param {unknown} name - Entity name to validate
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If name is null, undefined, or empty
   */
  static validateEntityName(
    name: unknown,
    context?: string,
  ): asserts name is string {
    const ctx = context || "entity";

    if (name === null || name === undefined) {
      throw new Error(`${ctx}: name is null or undefined`);
    }

    if (typeof name !== "string") {
      throw new Error(`${ctx}: name must be string, got ${typeof name}`);
    }

    if (name.trim().length === 0) {
      throw new Error(`${ctx}: name cannot be empty`);
    }
  }

  /**
   * Validate day number (1-30)
   *
   * @description Validates that day is a finite number between 1 and 30.
   *
   * @param {unknown} day - Day number to validate
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If day is not a number or outside valid range
   */
  static validateDayNumber(
    day: unknown,
    context?: string,
  ): asserts day is number {
    const ctx = context || "day";

    if (typeof day !== "number") {
      throw new Error(`${ctx}: day must be number, got ${typeof day}`);
    }

    if (!Number.isFinite(day)) {
      throw new Error(`${ctx}: day must be finite number`);
    }

    if (day < 1 || day > 30) {
      throw new Error(`${ctx}: day must be between 1 and 30, got ${day}`);
    }
  }

  /**
   * Validate timestamp
   *
   * @description Validates that timestamp is a valid Date object or ISO string.
   *
   * @param {unknown} timestamp - Timestamp to validate (Date or ISO string)
   * @param {string} [context] - Context for error messages (optional)
   * @returns {void}
   * @throws {Error} If timestamp is invalid or cannot be parsed
   */
  static validateTimestamp(timestamp: unknown, context?: string): void {
    const ctx = context || "timestamp";

    if (!timestamp) {
      throw new Error(`${ctx}: timestamp is required`);
    }

    let date: Date;

    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === "string") {
      date = new Date(timestamp);
    } else {
      throw new Error(
        `${ctx}: timestamp must be Date or ISO string, got ${typeof timestamp}`,
      );
    }

    if (Number.isNaN(date.getTime())) {
      throw new Error(`${ctx}: timestamp is invalid date`);
    }
  }

  /**
   * Validate array is not empty
   *
   * @description Validates that an array exists and is not empty.
   *
   * @param {T[]} arr - Array to validate
   * @param {string} context - Context for error messages
   * @returns {void}
   * @throws {Error} If array is not an array or is empty
   */
  static validateNotEmpty<T>(arr: T[], context: string): void {
    if (!Array.isArray(arr)) {
      throw new Error(`${context}: must be an array`);
    }

    if (arr.length === 0) {
      throw new Error(`${context}: cannot be empty`);
    }
  }

  /**
   * Truncate content to maximum length
   *
   * @description Truncates content to maximum length, adding ellipsis if
   * truncated. Logs a warning when truncation occurs.
   *
   * @param {string} content - Content to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} Truncated content with ellipsis if needed
   */
  static truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    logger.warn(
      "Truncating content",
      {
        originalLength: content.length,
        maxLength,
      },
      "ContentValidator",
    );

    return `${content.substring(0, maxLength - 3)}...`;
  }

  /**
   * Sanitize content (remove invalid characters, trim)
   *
   * @description Removes null bytes and control characters from content,
   * then trims whitespace. Ensures content is safe for storage and display.
   *
   * @param {string} content - Content to sanitize
   * @returns {string} Sanitized content
   */
  static sanitizeContent(content: string): string {
    return content
      .trim()
      .replace(/\u0000/g, "") // Remove null bytes
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ""); // Remove control characters
  }
}
