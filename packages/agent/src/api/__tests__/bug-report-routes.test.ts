/**
 * Unit tests for bug report routes helpers, repository resolution, input sanitization,
 * and client submission rate limiting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUG_REPORT_REPO_ENV_KEY,
  DEFAULT_BUG_REPORT_FETCH_TIMEOUT_MS,
  DEFAULT_BUG_REPORT_REPO,
  rateLimitBugReport,
  resetBugReportRateLimit,
  resolveBugReportRepo,
  sanitize,
} from "../bug-report-routes.ts";

describe("bug-report-routes", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
  });

  afterEach(() => {
    resetBugReportRateLimit();
  });

  describe("constants", () => {
    it("exposes documented default values and env keys", () => {
      expect(DEFAULT_BUG_REPORT_REPO).toBe("elizaOS/eliza");
      expect(BUG_REPORT_REPO_ENV_KEY).toBe("ELIZA_BUG_REPORT_REPO");
      expect(DEFAULT_BUG_REPORT_FETCH_TIMEOUT_MS).toBe(10_000);
    });
  });

  describe("resolveBugReportRepo", () => {
    it("resolves configured repository from primary env variable", () => {
      const env = { [BUG_REPORT_REPO_ENV_KEY]: "my-org/my-repo" };
      expect(resolveBugReportRepo(env)).toBe("my-org/my-repo");
    });

    it("falls back to secondary BUG_REPORT_REPO env variable", () => {
      const env = { BUG_REPORT_REPO: "custom-org/custom-repo" };
      expect(resolveBugReportRepo(env)).toBe("custom-org/custom-repo");
    });

    it("falls back to DEFAULT_BUG_REPORT_REPO when env values are invalid or unset", () => {
      expect(resolveBugReportRepo({})).toBe("elizaOS/eliza");
      expect(resolveBugReportRepo({ [BUG_REPORT_REPO_ENV_KEY]: "" })).toBe(
        "elizaOS/eliza",
      );
      expect(
        resolveBugReportRepo({ [BUG_REPORT_REPO_ENV_KEY]: "invalid-no-slash" }),
      ).toBe("elizaOS/eliza");
      expect(
        resolveBugReportRepo({ [BUG_REPORT_REPO_ENV_KEY]: "bad/repo/path" }),
      ).toBe("elizaOS/eliza");
    });
  });

  describe("sanitize", () => {
    it("strips nested and inline HTML tags", () => {
      expect(sanitize("Hello <b>bold</b> world")).toBe("Hello bold world");
      expect(sanitize("<div><p>Formatted <b>bold</b></p></div>")).toBe(
        "Formatted bold",
      );
    });

    it("removes stray angle brackets", () => {
      expect(sanitize("5 < 10 and 20 > 15")).toBe("5  15");
      expect(sanitize("unpaired < bracket")).toBe("unpaired  bracket");
    });

    it("truncates strings exceeding maxLen parameter", () => {
      const long = "a".repeat(100);
      expect(sanitize(long, 50)).toHaveLength(50);
    });
  });

  describe("rateLimitBugReport", () => {
    it("allows up to 5 submissions per IP within window", () => {
      const ip = "192.0.2.1";
      for (let i = 0; i < 5; i++) {
        expect(rateLimitBugReport(ip)).toBe(true);
      }
      expect(rateLimitBugReport(ip)).toBe(false);
    });

    it("isolates rate limits by client IP", () => {
      for (let i = 0; i < 5; i++) {
        expect(rateLimitBugReport("10.0.0.1")).toBe(true);
      }
      expect(rateLimitBugReport("10.0.0.1")).toBe(false);
      expect(rateLimitBugReport("10.0.0.2")).toBe(true);
    });

    it("resets rate limit state on resetBugReportRateLimit", () => {
      for (let i = 0; i < 5; i++) {
        rateLimitBugReport("172.16.0.1");
      }
      expect(rateLimitBugReport("172.16.0.1")).toBe(false);
      resetBugReportRateLimit();
      expect(rateLimitBugReport("172.16.0.1")).toBe(true);
    });
  });
});
