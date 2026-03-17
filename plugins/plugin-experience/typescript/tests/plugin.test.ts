import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordExperienceAction } from "../actions/record-experience";
import { experienceEvaluator } from "../evaluators/experienceEvaluator";
import { experiencePlugin } from "../index";
import { experienceProvider } from "../providers/experienceProvider";
import { ExperienceService } from "../service";
import { type Experience, ExperienceType, OutcomeType } from "../types";
import { ConfidenceDecayManager } from "../utils/confidenceDecay";
import {
  extractKeywords,
  formatExperienceForDisplay,
  formatExperienceForRAG,
  formatExperienceList,
  formatExperienceSummary,
  getExperienceStats,
  groupExperiencesByDomain,
} from "../utils/experienceFormatter";
import { ExperienceRelationshipManager } from "../utils/experienceRelationships";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a deterministic fake embedding from text. Texts sharing words will
 * produce embeddings with non-zero cosine similarity — good enough for
 * in-memory similarity-search tests.
 */
function fakeEmbedding(text: string): number[] {
  const dim = 16;
  const vec = new Array<number>(dim).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * 7 + i) % dim;
      vec[idx] += 1;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;

/**
 * Build a minimal mock runtime that satisfies the ExperienceService needs.
 * `unknown` cast is necessary because we only implement the subset of
 * IAgentRuntime that the experience plugin actually calls.
 */
function createMockRuntime(): IAgentRuntime {
  const cache = new Map<string, string>();

  return {
    agentId: AGENT_ID,
    getSetting: vi.fn((_key: string) => undefined),
    setSetting: vi.fn(),
    getMemories: vi.fn(async () => []),
    createMemory: vi.fn(async () => {}),
    useModel: vi.fn(async (_type: string, params: { text?: string; prompt?: string }) => {
      // TEXT_EMBEDDING requests have a `text` field
      if (typeof params === "object" && params !== null && "text" in params) {
        return fakeEmbedding(String(params.text ?? ""));
      }
      // TEXT_LARGE (evaluator) returns a string
      return "[]";
    }),
    getService: vi.fn(() => null),
    getCache: vi.fn(async (key: string) => cache.get(key) ?? null),
    setCache: vi.fn(async (key: string, value: string) => {
      cache.set(key, value);
    }),
  } as unknown as IAgentRuntime;
}

function createMessage(
  text: string,
  entityId: UUID = "00000000-0000-0000-0000-000000000002" as UUID
): Memory {
  return {
    id: `msg-${Date.now()}` as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

function makeExperience(overrides: Partial<Experience> = {}): Experience {
  const now = Date.now();
  return {
    id: `exp-${Math.random().toString(36).slice(2)}` as UUID,
    agentId: AGENT_ID,
    type: ExperienceType.LEARNING,
    outcome: OutcomeType.NEUTRAL,
    context: "test context",
    action: "test action",
    result: "test result",
    learning: "test learning about software",
    tags: ["test"],
    domain: "general",
    confidence: 0.8,
    importance: 0.7,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

describe("Plugin Metadata", () => {
  it("exports plugin name and description", () => {
    expect(experiencePlugin.name).toBe("experience");
    expect(experiencePlugin.description).toContain("experience");
  });

  it("registers services, actions, providers, evaluators", () => {
    expect(experiencePlugin.services?.length).toBeGreaterThan(0);
    expect(experiencePlugin.actions?.length).toBeGreaterThan(0);
    expect(experiencePlugin.providers?.length).toBeGreaterThan(0);
    expect(experiencePlugin.evaluators?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// recordExperienceAction
// ---------------------------------------------------------------------------

describe("recordExperienceAction", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  describe("validate", () => {
    it("triggers on 'remember'", async () => {
      const msg = createMessage("Please remember this for later");
      expect(await recordExperienceAction.validate(runtime, msg)).toBe(true);
    });

    it("triggers on 'record'", async () => {
      const msg = createMessage("Record this experience");
      expect(await recordExperienceAction.validate(runtime, msg)).toBe(true);
    });

    it("rejects messages without trigger words", async () => {
      const msg = createMessage("What is 2+2?");
      expect(await recordExperienceAction.validate(runtime, msg)).toBe(false);
    });

    it("rejects empty message", async () => {
      const msg = createMessage("");
      expect(await recordExperienceAction.validate(runtime, msg)).toBe(false);
    });
  });

  describe("handler", () => {
    it("records an experience and returns success", async () => {
      const msg = createMessage("Remember that Python needs deps installed");
      const result = await recordExperienceAction.handler(runtime, msg);

      expect(result.success).toBe(true);
      expect(result.text).toContain("recorded");
      expect(vi.mocked(runtime.createMemory)).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// ExperienceService
// ---------------------------------------------------------------------------

describe("ExperienceService", () => {
  let runtime: IAgentRuntime;
  let service: ExperienceService;

  beforeEach(async () => {
    runtime = createMockRuntime();
    service = await ExperienceService.start(runtime);
    // Wait for fire-and-forget loadExperiences to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe("recordExperience", () => {
    it("records and returns an experience with an id", async () => {
      const exp = await service.recordExperience({
        type: ExperienceType.LEARNING,
        outcome: OutcomeType.NEUTRAL,
        context: "debugging a failing build",
        action: "run tests",
        result: "fixed missing dependency",
        learning: "Install dependencies before running Python scripts",
        domain: "coding",
        tags: ["extracted"],
        confidence: 0.9,
        importance: 0.8,
      });

      expect(exp.id).toBeDefined();
      expect(exp.learning).toBe("Install dependencies before running Python scripts");
      expect(exp.domain).toBe("coding");
      expect(exp.confidence).toBe(0.9);
      expect(exp.type).toBe(ExperienceType.LEARNING);
    });

    it("generates an embedding for the experience", async () => {
      const exp = await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "learned something",
      });

      expect(exp.embedding).toBeDefined();
      expect(Array.isArray(exp.embedding)).toBe(true);
      expect(exp.embedding!.length).toBeGreaterThan(0);
    });
  });

  describe("queryExperiences", () => {
    it("queries by type filter", async () => {
      await service.recordExperience({
        type: ExperienceType.LEARNING,
        context: "ctx",
        action: "act",
        result: "res",
        learning: "learning-thing",
        confidence: 0.9,
        importance: 0.8,
      });
      await service.recordExperience({
        type: ExperienceType.DISCOVERY,
        context: "ctx",
        action: "act",
        result: "res",
        learning: "discovery-thing",
        confidence: 0.9,
        importance: 0.8,
      });

      const results = await service.queryExperiences({
        type: ExperienceType.DISCOVERY,
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0].type).toBe(ExperienceType.DISCOVERY);
    });

    it("queries by domain filter", async () => {
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "shell thing",
        domain: "shell",
        confidence: 0.9,
        importance: 0.8,
      });
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "coding thing",
        domain: "coding",
        confidence: 0.9,
        importance: 0.8,
      });

      const results = await service.queryExperiences({
        domain: "coding",
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0].domain).toBe("coding");
    });

    it("queries by tag filter", async () => {
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "tagged",
        tags: ["important", "novel"],
        confidence: 0.9,
        importance: 0.8,
      });
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "not tagged",
        tags: [],
        confidence: 0.9,
        importance: 0.8,
      });

      const results = await service.queryExperiences({
        tags: ["important"],
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0].tags).toContain("important");
    });

    it("queries by confidence and importance", async () => {
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "high quality",
        confidence: 0.9,
        importance: 0.9,
      });
      await service.recordExperience({
        context: "ctx",
        action: "act",
        result: "res",
        learning: "low quality",
        confidence: 0.3,
        importance: 0.3,
      });

      const results = await service.queryExperiences({
        minConfidence: 0.7,
        minImportance: 0.7,
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0].confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await service.recordExperience({
          context: `ctx-${i}`,
          action: "act",
          result: "res",
          learning: `learning-${i}`,
          confidence: 0.9,
          importance: 0.8,
        });
      }

      const results = await service.queryExperiences({ limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe("findSimilarExperiences", () => {
    it("finds experiences with related text", async () => {
      await service.recordExperience({
        context: "debugging build failure",
        action: "install packages",
        result: "build succeeded",
        learning: "Always install dependencies before building Python projects",
        domain: "coding",
        confidence: 0.9,
        importance: 0.8,
      });

      await service.recordExperience({
        context: "weather discussion",
        action: "check weather",
        result: "sunny day",
        learning: "Weather patterns are unpredictable in spring",
        domain: "general",
        confidence: 0.5,
        importance: 0.3,
      });

      const results = await service.findSimilarExperiences(
        "install python dependencies for build",
        5
      );

      expect(results.length).toBeGreaterThan(0);
      // The coding experience should rank higher because of word overlap
      expect(results[0].domain).toBe("coding");
    });

    it("returns empty for empty text", async () => {
      const results = await service.findSimilarExperiences("", 5);
      expect(results).toEqual([]);
    });

    it("returns empty when no experiences stored", async () => {
      const results = await service.findSimilarExperiences("some text", 5);
      expect(results).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// experienceProvider
// ---------------------------------------------------------------------------

describe("experienceProvider", () => {
  let runtime: IAgentRuntime;
  let service: ExperienceService;

  beforeEach(async () => {
    runtime = createMockRuntime();
    service = await ExperienceService.start(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("returns empty for short messages", async () => {
    vi.mocked(runtime.getService).mockReturnValue(service);
    const msg = createMessage("hi");
    const result = await experienceProvider.get(runtime, msg);

    expect(result.text).toBe("");
  });

  it("returns empty when service is not available", async () => {
    // getService returns null by default
    const msg = createMessage("How do I install dependencies?");
    const result = await experienceProvider.get(runtime, msg);

    expect(result.text).toBe("");
  });

  it("formats relevant experiences into context text", async () => {
    await service.recordExperience({
      context: "debugging build",
      action: "install packages",
      result: "build succeeded",
      learning: "Install dependencies before running Python scripts",
      domain: "coding",
      confidence: 0.9,
      importance: 0.8,
    });

    vi.mocked(runtime.getService).mockReturnValue(service);

    const msg = createMessage("How do I install dependencies for Python scripts?");
    const result = await experienceProvider.get(runtime, msg);

    expect(result.text).toContain("[RELEVANT EXPERIENCES]");
    expect(result.text).toContain("[/RELEVANT EXPERIENCES]");
    expect(result.text).toContain("Experience 1:");
    expect(result.text).toContain("Install dependencies");
    expect(result.data.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// experienceEvaluator
// ---------------------------------------------------------------------------

describe("experienceEvaluator", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  describe("validate", () => {
    it("rejects non-agent messages", async () => {
      const msg = createMessage("test", "00000000-0000-0000-0000-000000000099" as UUID);
      const result = await experienceEvaluator.validate(runtime, msg);
      expect(result).toBe(false);
    });

    it("accepts agent messages and tracks count", async () => {
      // Should trigger on every 10th message
      let triggered = false;
      for (let i = 0; i < 20; i++) {
        const msg = createMessage("agent message", AGENT_ID);
        const result = await experienceEvaluator.validate(runtime, msg);
        if (result) triggered = true;
      }
      expect(triggered).toBe(true);
    });

    it("triggers exactly on 10th message", async () => {
      const results: boolean[] = [];
      for (let i = 0; i < 11; i++) {
        const msg = createMessage("agent message", AGENT_ID);
        results.push(await experienceEvaluator.validate(runtime, msg));
      }
      // Message 10 (index 9) should be true
      expect(results[9]).toBe(true);
      // Others before should be false
      expect(results.slice(0, 9).every((r) => !r)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ConfidenceDecayManager
// ---------------------------------------------------------------------------

describe("ConfidenceDecayManager", () => {
  const manager = new ConfidenceDecayManager();

  it("returns original confidence during grace period", () => {
    const exp = makeExperience({
      confidence: 0.9,
      createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
    });

    const decayed = manager.getDecayedConfidence(exp);
    expect(decayed).toBe(0.9);
  });

  it("decays confidence after grace period", () => {
    const exp = makeExperience({
      confidence: 0.9,
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
    });

    const decayed = manager.getDecayedConfidence(exp);
    expect(decayed).toBeLessThan(0.9);
    expect(decayed).toBeGreaterThan(0);
  });

  it("respects minimum confidence", () => {
    const exp = makeExperience({
      confidence: 0.9,
      createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    });

    const decayed = manager.getDecayedConfidence(exp);
    expect(decayed).toBeGreaterThanOrEqual(0.1);
  });

  it("applies domain-specific decay for DISCOVERY (slower decay)", () => {
    const discovery = makeExperience({
      type: ExperienceType.DISCOVERY,
      confidence: 0.9,
      createdAt: Date.now() - 45 * 24 * 60 * 60 * 1000, // 45 days ago
    });
    const learning = makeExperience({
      type: ExperienceType.SUCCESS,
      confidence: 0.9,
      createdAt: Date.now() - 45 * 24 * 60 * 60 * 1000,
    });

    const discoveryDecayed = manager.getDecayedConfidence(discovery);
    const learningDecayed = manager.getDecayedConfidence(learning);

    // Discovery should retain more confidence (slower decay)
    expect(discoveryDecayed).toBeGreaterThan(learningDecayed);
  });

  it("calculates reinforcement boost", () => {
    const exp = makeExperience({
      confidence: 0.5,
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    });

    const boosted = manager.calculateReinforcementBoost(exp, 1.0);
    const current = manager.getDecayedConfidence(exp);

    expect(boosted).toBeGreaterThan(current);
    expect(boosted).toBeLessThanOrEqual(1.0);
  });

  it("identifies experiences needing reinforcement", () => {
    const fresh = makeExperience({
      confidence: 0.9,
      createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
    });
    // 60 days old, SUCCESS type: decays to ~0.15 (above min 0.1, below threshold 0.3)
    const old = makeExperience({
      confidence: 0.5,
      type: ExperienceType.SUCCESS,
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    });

    const needingReinforcement = manager.getExperiencesNeedingReinforcement([fresh, old], 0.3);

    // The old experience should need reinforcement
    expect(needingReinforcement.some((e) => e.id === old.id)).toBe(true);
    expect(needingReinforcement.some((e) => e.id === fresh.id)).toBe(false);
  });

  it("returns confidence trend over time", () => {
    const exp = makeExperience({
      confidence: 0.9,
      createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });

    const trend = manager.getConfidenceTrend(exp, 5);

    expect(trend.length).toBe(5);
    // First point should have original confidence (within grace period)
    expect(trend[0].confidence).toBe(0.9);
    // Later points should be lower
    expect(trend[trend.length - 1].confidence).toBeLessThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// ExperienceRelationshipManager
// ---------------------------------------------------------------------------

describe("ExperienceRelationshipManager", () => {
  it("adds and retrieves relationships", () => {
    const manager = new ExperienceRelationshipManager();

    manager.addRelationship({
      fromId: "exp-1",
      toId: "exp-2",
      type: "supports",
      strength: 0.8,
    });

    const rels = manager.findRelationships("exp-1");
    expect(rels.length).toBe(1);
    expect(rels[0].toId).toBe("exp-2");
    expect(rels[0].type).toBe("supports");
  });

  it("filters relationships by type", () => {
    const manager = new ExperienceRelationshipManager();

    manager.addRelationship({
      fromId: "exp-1",
      toId: "exp-2",
      type: "supports",
      strength: 0.8,
    });
    manager.addRelationship({
      fromId: "exp-1",
      toId: "exp-3",
      type: "contradicts",
      strength: 0.6,
    });

    const supports = manager.findRelationships("exp-1", "supports");
    expect(supports.length).toBe(1);
    expect(supports[0].toId).toBe("exp-2");
  });

  it("finds contradictions between experiences", () => {
    const manager = new ExperienceRelationshipManager();

    const exp1 = makeExperience({
      id: "exp-1" as UUID,
      action: "deploy",
      outcome: OutcomeType.POSITIVE,
      domain: "coding",
    });
    const exp2 = makeExperience({
      id: "exp-2" as UUID,
      action: "deploy",
      outcome: OutcomeType.NEGATIVE,
      domain: "coding",
    });

    const contradictions = manager.findContradictions(exp1, [exp1, exp2]);

    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0].id).toBe("exp-2");
  });

  it("returns empty when no contradictions", () => {
    const manager = new ExperienceRelationshipManager();

    const exp1 = makeExperience({
      id: "exp-1" as UUID,
      action: "test",
      outcome: OutcomeType.POSITIVE,
      domain: "coding",
    });
    const exp2 = makeExperience({
      id: "exp-2" as UUID,
      action: "test",
      outcome: OutcomeType.POSITIVE,
      domain: "coding",
    });

    const contradictions = manager.findContradictions(exp1, [exp1, exp2]);
    expect(contradictions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// experienceFormatter
// ---------------------------------------------------------------------------

describe("experienceFormatter", () => {
  it("formats experience for display", () => {
    const exp = makeExperience({
      type: ExperienceType.SUCCESS,
      action: "deploy",
      learning: "Always run tests before deploying",
      confidence: 0.95,
      importance: 0.9,
      domain: "coding",
      tags: ["ci", "deployment"],
    });

    const display = formatExperienceForDisplay(exp);

    expect(display).toContain("SUCCESS");
    expect(display).toContain("deploy");
    expect(display).toContain("Always run tests before deploying");
    expect(display).toContain("95%");
    expect(display).toContain("coding");
  });

  it("formats experience summary", () => {
    const exp = makeExperience({
      learning: "Use retry logic for network calls",
      confidence: 0.8,
    });

    const summary = formatExperienceSummary(exp);

    expect(summary).toContain("Use retry logic for network calls");
    expect(summary).toContain("80%");
  });

  it("formats experience list", () => {
    const exps = [
      makeExperience({ learning: "First learning" }),
      makeExperience({ learning: "Second learning" }),
    ];

    const list = formatExperienceList(exps);

    expect(list).toContain("1.");
    expect(list).toContain("2.");
    expect(list).toContain("First learning");
    expect(list).toContain("Second learning");
  });

  it("formats empty experience list", () => {
    const list = formatExperienceList([]);
    expect(list).toContain("No experiences found");
  });

  it("computes experience stats", () => {
    const exps = [
      makeExperience({
        type: ExperienceType.SUCCESS,
        outcome: OutcomeType.POSITIVE,
        domain: "coding",
        confidence: 0.9,
        importance: 0.8,
      }),
      makeExperience({
        type: ExperienceType.FAILURE,
        outcome: OutcomeType.NEGATIVE,
        domain: "shell",
        confidence: 0.7,
        importance: 0.6,
      }),
      makeExperience({
        type: ExperienceType.SUCCESS,
        outcome: OutcomeType.POSITIVE,
        domain: "coding",
        confidence: 0.8,
        importance: 0.7,
      }),
    ];

    const stats = getExperienceStats(exps);

    expect(stats.total).toBe(3);
    expect(stats.byType[ExperienceType.SUCCESS]).toBe(2);
    expect(stats.byType[ExperienceType.FAILURE]).toBe(1);
    expect(stats.byOutcome[OutcomeType.POSITIVE]).toBe(2);
    expect(stats.byDomain["coding"]).toBe(2);
    expect(stats.byDomain["shell"]).toBe(1);
    expect(stats.averageConfidence).toBeCloseTo(0.8, 1);
    expect(stats.successRate).toBeCloseTo(2 / 3, 2);
  });

  it("groups experiences by domain", () => {
    const exps = [
      makeExperience({ domain: "coding" }),
      makeExperience({ domain: "shell" }),
      makeExperience({ domain: "coding" }),
    ];

    const groups = groupExperiencesByDomain(exps);

    expect(groups.get("coding")?.length).toBe(2);
    expect(groups.get("shell")?.length).toBe(1);
  });

  it("extracts keywords from experience", () => {
    const exp = makeExperience({
      learning: "Install dependencies before building projects",
      action: "build_project",
      tags: ["dependencies", "python"],
      domain: "coding",
    });

    const keywords = extractKeywords(exp);

    expect(keywords).toContain("dependencies");
    expect(keywords).toContain("python");
    expect(keywords).toContain("coding");
    expect(keywords).toContain("install");
  });

  it("formats experience for RAG", () => {
    const exp = makeExperience({
      type: ExperienceType.CORRECTION,
      previousBelief: "pip install works everywhere",
      correctedBelief: "need venv first",
    });

    const rag = formatExperienceForRAG(exp);

    expect(rag).toContain("Experience Type: correction");
    expect(rag).toContain("Previous Belief: pip install works everywhere");
    expect(rag).toContain("Corrected Belief: need venv first");
  });
});
