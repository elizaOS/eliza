import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { scanSkillAction } from "./scan-skill.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { SkillScoreResponse, SkillScanResponse } from "../client/types.js";

function makeMessage(text: string, extra: Record<string, unknown> = {}): Memory {
  return {
    content: { text, ...extra },
    userId: "user-1",
    agentId: "agent-1",
    roomId: "room-1",
  } as Memory;
}

function makeRuntime(): IAgentRuntime {
  return { agentId: "agent-1" } as unknown as IAgentRuntime;
}

function makeSkillResult(overrides: Partial<SkillScoreResponse> = {}): SkillScoreResponse {
  return {
    skill: "owner/repo",
    source: "github",
    version: null,
    score: 75,
    badge: "caution",
    scanned_at: "2026-02-16T00:00:00Z",
    files_scanned: 10,
    publisher: {
      score: 60,
      name: "owner",
      verified: false,
      verification_method: null,
      skills_published: 1,
      flags: 0,
      notes: "New publisher",
    },
    endpoints: {
      score: 80,
      x402_endpoints: [
        { url: "https://api.test.com/", domain: "api.test.com", status: "trusted", bazaar_score: 85 },
      ],
    },
    domains: {
      score: 70,
      external_calls: [],
      unknown_domains: ["shady.xyz"],
    },
    recommendations: {
      install: true,
      escrow: "recommended",
      notes: "Use with caution",
      warnings: ["Unknown external domain detected"],
    },
    _cached: false,
    ...overrides,
  } as SkillScoreResponse;
}

describe("scanSkillAction", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true for scan + skill keywords", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("scan this mcp server"))).toBe(true);
    });

    it("returns true for audit + plugin keywords", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("audit this plugin"))).toBe(true);
    });

    it("returns true for security + code keywords", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("security check the code"))).toBe(true);
    });

    it("returns false when only scan keyword", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("scan for issues"))).toBe(false);
    });

    it("returns false when only skill keyword", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("install this plugin"))).toBe(false);
    });

    it("returns false for unrelated message", async () => {
      expect(await scanSkillAction.validate(runtime, makeMessage("what's the weather?"))).toBe(false);
    });
  });

  describe("handler - GitHub repo", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getSkillScore: ReturnType<typeof vi.fn>; scanSkill: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getSkillScore: vi.fn(), scanSkill: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("extracts GitHub repo and calls getSkillScore", async () => {
      mockClient.getSkillScore.mockResolvedValue(makeSkillResult());
      const callback = vi.fn();

      const result = await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo for security issues"), undefined, undefined, callback
      );

      expect(mockClient.getSkillScore).toHaveBeenCalledWith("github", "owner/repo", { fetch: true });
      expect(result).toEqual({ success: true, data: expect.any(Object) });
    });

    it("formats skill result with all sections", async () => {
      mockClient.getSkillScore.mockResolvedValue(makeSkillResult());
      const callback = vi.fn();

      await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo"), undefined, undefined, callback
      );

      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("Skill Scan: owner/repo");
      expect(text).toContain("75/100");
      expect(text).toContain("[CAUTION] CAUTION");
      expect(text).toContain("Publisher");
      expect(text).toContain("owner (score 60/100)");
      expect(text).toContain("x402 Endpoints");
      expect(text).toContain("api.test.com");
      expect(text).toContain("bazaar score: 85");
      expect(text).toContain("Unknown External Domains");
      expect(text).toContain("shady.xyz");
      expect(text).toContain("Recommendation");
      expect(text).toContain("Install: Yes");
      expect(text).toContain("Escrow: recommended");
      expect(text).toContain("Warnings");
      expect(text).toContain("Unknown external domain detected");
    });

    it("shows [VERIFIED] for verified publishers", async () => {
      const result = makeSkillResult();
      result.publisher.verified = true;
      mockClient.getSkillScore.mockResolvedValue(result);
      const callback = vi.fn();

      await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("[VERIFIED]");
    });

    it("shows [SAFE] badge for safe score", async () => {
      mockClient.getSkillScore.mockResolvedValue(makeSkillResult({ badge: "safe" }));
      const callback = vi.fn();

      await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("[SAFE] SAFE");
    });

    it("shows [DANGER] badge for dangerous score", async () => {
      mockClient.getSkillScore.mockResolvedValue(makeSkillResult({ badge: "danger" }));
      const callback = vi.fn();

      await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("[DANGER] DANGER");
    });

    it("handles GitHub fetch error", async () => {
      mockClient.getSkillScore.mockRejectedValue(new Error("Rate limited"));
      const callback = vi.fn();

      const result = await scanSkillAction.handler(
        runtime, makeMessage("scan github.com/owner/repo"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("Failed to scan owner/repo");
    });
  });

  describe("handler - file upload", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getSkillScore: ReturnType<typeof vi.fn>; scanSkill: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getSkillScore: vi.fn(), scanSkill: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("scans uploaded files when no GitHub URL", async () => {
      const scanResult = {
        skill: "my-skill",
        source: "upload",
        version: null,
        score: 80,
        badge: "safe",
        scanned_at: "2026-02-16",
        publisher: { score: 50, name: "unknown", verified: false, verification_method: null, skills_published: 0, flags: 0, notes: "" },
        endpoints: { score: 100, x402_endpoints: [] },
        domains: { score: 100, external_calls: [], unknown_domains: [] },
        recommendations: { install: true, escrow: "optional", notes: "Looks safe", warnings: [] },
      } as unknown as SkillScanResponse;
      mockClient.scanSkill.mockResolvedValue(scanResult);
      const callback = vi.fn();

      const msg = makeMessage("scan this skill for security", {
        files: { "index.ts": "console.log('hello');" },
        skillName: "my-skill",
      });

      const result = await scanSkillAction.handler(runtime, msg, undefined, undefined, callback);

      expect(mockClient.scanSkill).toHaveBeenCalledWith({
        source: "upload",
        identifier: "my-skill",
        files: { "index.ts": "console.log('hello');" },
      });
      expect(result).toEqual({ success: true, data: expect.any(Object) });
    });

    it("uses 'unknown-skill' when skillName not provided", async () => {
      const scanResult = {
        skill: "unknown-skill",
        source: "upload",
        version: null,
        score: 80,
        badge: "safe",
        scanned_at: "2026-02-16",
        publisher: { score: 50, name: "unknown", verified: false, verification_method: null, skills_published: 0, flags: 0, notes: "" },
        endpoints: { score: 100, x402_endpoints: [] },
        domains: { score: 100, external_calls: [], unknown_domains: [] },
        recommendations: { install: true, escrow: "optional", notes: "Looks safe", warnings: [] },
      } as unknown as SkillScanResponse;
      mockClient.scanSkill.mockResolvedValue(scanResult);

      const msg = makeMessage("scan this skill", {
        files: { "index.ts": "code" },
      });

      await scanSkillAction.handler(runtime, msg, undefined, undefined, vi.fn());

      expect(mockClient.scanSkill).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: "unknown-skill" })
      );
    });
  });

  describe("handler - no input", () => {
    it("prompts for GitHub URL or files when neither provided", async () => {
      const runtime = makeRuntime();
      setScoutClient(runtime, { getSkillScore: vi.fn(), scanSkill: vi.fn() } as unknown as ScoutClient);
      const callback = vi.fn();

      const result = await scanSkillAction.handler(
        runtime, makeMessage("scan this skill for security"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("GitHub URL");
    });

    it("returns failure when client not initialized", async () => {
      const bareRuntime = makeRuntime();
      const callback = vi.fn();
      const result = await scanSkillAction.handler(
        bareRuntime, makeMessage("scan github.com/o/r skill"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
    });
  });
});