import { describe, expect, it } from "bun:test";
import { formatTimeAgo } from "./CommentPreview";

/**
 * Tests for CommentPreview component logic.
 *
 * Note: These tests verify the conditional rendering logic and utility functions.
 * Full component rendering tests would require @testing-library/react.
 */

describe("CommentPreview - formatTimeAgo", () => {
  it('should return "just now" for timestamps less than 1 minute ago', () => {
    const now = new Date().toISOString();
    expect(formatTimeAgo(now)).toBe("just now");
  });

  it("should return minutes ago for timestamps under 1 hour", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");

    const thirtyMinutesAgo = new Date(
      Date.now() - 30 * 60 * 1000,
    ).toISOString();
    expect(formatTimeAgo(thirtyMinutesAgo)).toBe("30m ago");
  });

  it("should return hours ago for timestamps under 24 hours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(twoHoursAgo)).toBe("2h ago");

    const twelveHoursAgo = new Date(
      Date.now() - 12 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatTimeAgo(twelveHoursAgo)).toBe("12h ago");
  });

  it("should return days ago for timestamps under 7 days", () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatTimeAgo(threeDaysAgo)).toBe("3d ago");
  });

  it("should return weeks ago for timestamps under 4 weeks", () => {
    const twoWeeksAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatTimeAgo(twoWeeksAgo)).toBe("2w ago");

    // 3 weeks (21 days) - still under 4 weeks boundary
    const threeWeeksAgo = new Date(
      Date.now() - 21 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatTimeAgo(threeWeeksAgo)).toBe("3w ago");
  });

  it("should handle 4-week boundary and older timestamps", () => {
    // Exactly 4 weeks (28 days) - at the boundary, should use formatDistanceToNow
    const fourWeeksAgo = new Date(
      Date.now() - 28 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fourWeeksResult = formatTimeAgo(fourWeeksAgo);
    // formatDistanceToNow returns strings like "about 1 month ago"
    expect(fourWeeksResult).toContain("ago");
    expect(fourWeeksResult).not.toBe("4w ago"); // Should NOT be weeks format

    // 60 days - well past the 4-week boundary
    const sixtyDaysAgo = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const sixtyDaysResult = formatTimeAgo(sixtyDaysAgo);
    expect(sixtyDaysResult).toContain("ago");
    expect(sixtyDaysResult).not.toMatch(/^\d+w ago$/); // Should NOT be weeks format
  });

  it("should return empty string for invalid timestamps", () => {
    // Empty string creates Invalid Date with NaN time
    // The try/catch in formatTimeAgo handles this gracefully
    expect(formatTimeAgo("")).toBe("");

    // Completely invalid date string
    expect(formatTimeAgo("not-a-date")).toBe("");

    // Invalid format that can't be parsed
    expect(formatTimeAgo("invalid")).toBe("");
  });
});

describe("CommentPreview - Conditional Rendering Logic", () => {
  /**
   * Simulates the conditional logic used in CommentPreview component.
   * Returns what sections should be rendered based on input.
   *
   * Note: The actual component requires comments as CommentPreviewData[],
   * and PostCard always passes `post.commentPreviews ?? []`, so comments
   * is always a valid array. This test reflects that type-safe behavior.
   */

  /**
   * Intentionally minimal subset of CommentPreviewData from @feed/shared.
   * The render-decision logic only checks comments.length, not individual
   * comment properties, so we use a minimal shape for test clarity.
   * See: packages/shared/src/game-types.ts for the full CommentPreviewData type.
   */
  interface CommentPreviewData {
    id: string;
    content: string;
  }

  interface RenderDecision {
    shouldRender: boolean;
    showCommentList: boolean;
    showViewAllLink: boolean;
    showInputBar: boolean;
    inputBarMarginTop: boolean;
  }

  function getCommentPreviewRenderDecision(
    comments: CommentPreviewData[],
    totalCommentCount: number,
    showInputBarProp: boolean = true,
  ): RenderDecision {
    // Type-safe: comments is always an array (required prop)
    const hasComments = comments.length > 0;

    // Don't render if no comments and input bar is hidden
    if (!hasComments && !showInputBarProp) {
      return {
        shouldRender: false,
        showCommentList: false,
        showViewAllLink: false,
        showInputBar: false,
        inputBarMarginTop: false,
      };
    }

    return {
      shouldRender: true,
      // Comment list only shown if there are comments - explicit boolean
      showCommentList: !!hasComments,
      // View all link only shown if there are more comments than previewed - explicit boolean
      showViewAllLink: !!hasComments && totalCommentCount > comments.length,
      // Input bar shown based on prop
      showInputBar: showInputBarProp,
      // Input bar has margin-top only when there are comments above it - explicit boolean
      inputBarMarginTop: !!hasComments,
    };
  }

  describe("with no comments (empty array)", () => {
    it("should show input bar but not comment list (default behavior)", () => {
      const result = getCommentPreviewRenderDecision([], 0);

      expect(result.shouldRender).toBe(true);
      expect(result.showCommentList).toBe(false);
      expect(result.showViewAllLink).toBe(false);
      expect(result.showInputBar).toBe(true);
      expect(result.inputBarMarginTop).toBe(false);
    });

    it("should not render when no comments and input bar hidden", () => {
      // Feed pages hide input bar - component returns null when no comments
      const result = getCommentPreviewRenderDecision([], 0, false);

      expect(result.shouldRender).toBe(false);
      expect(result.showCommentList).toBe(false);
      expect(result.showInputBar).toBe(false);
    });

    it("should handle empty array correctly (PostCard always passes [])", () => {
      // PostCard always passes `post.commentPreviews ?? []`
      // so this is the expected input for posts without comments
      const result = getCommentPreviewRenderDecision([], 0);

      expect(result.showCommentList).toBe(false);
      expect(result.showInputBar).toBe(true);
    });
  });

  describe("with comments", () => {
    const mockComments: CommentPreviewData[] = [
      { id: "1", content: "First comment" },
      { id: "2", content: "Second comment" },
    ];

    it("should show comment list and input bar (default)", () => {
      const result = getCommentPreviewRenderDecision(mockComments, 2);

      expect(result.shouldRender).toBe(true);
      expect(result.showCommentList).toBe(true);
      expect(result.showInputBar).toBe(true);
      expect(result.inputBarMarginTop).toBe(true);
    });

    it("should show comments but hide input bar (feed use case)", () => {
      // Feed pages show comments but hide input bar
      const result = getCommentPreviewRenderDecision(mockComments, 2, false);

      expect(result.shouldRender).toBe(true);
      expect(result.showCommentList).toBe(true);
      expect(result.showInputBar).toBe(false);
    });

    it('should show "view all" link when total exceeds previewed count', () => {
      const result = getCommentPreviewRenderDecision(mockComments, 10);

      expect(result.showViewAllLink).toBe(true);
    });

    it('should not show "view all" link when all comments are previewed', () => {
      const result = getCommentPreviewRenderDecision(mockComments, 2);

      expect(result.showViewAllLink).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle single comment correctly", () => {
      const singleComment = [{ id: "1", content: "Only comment" }];
      const result = getCommentPreviewRenderDecision(singleComment, 1);

      expect(result.showCommentList).toBe(true);
      expect(result.showViewAllLink).toBe(false);
      expect(result.showInputBar).toBe(true);
    });

    it("should handle high engagement post (50+ comments)", () => {
      const twoComments = [
        { id: "1", content: "Comment 1" },
        { id: "2", content: "Comment 2" },
      ];
      const result = getCommentPreviewRenderDecision(twoComments, 150);

      expect(result.showCommentList).toBe(true);
      expect(result.showViewAllLink).toBe(true);
      expect(result.showInputBar).toBe(true);
    });
  });
});
