import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findWeakestAlliedLane,
  type GameStrategy,
  isAutoPlayActive,
  parseStrategyUpdate,
  persistBestStrategy,
  persistStrategy,
  pickAbility,
  resetInMemoryStateForTests,
  resolveBestStrategy,
  resolveStrategy,
  runStrategyReview,
  scoreStrategy,
} from "./routes";

// Map-backed runtime stub: getSetting/setSetting persist into a Map (and mirror
// to process.env via persistSetting), so strategy promotion/revert and autoplay
// reads can be exercised without any runtime/db.
function makeRuntime(): IAgentRuntime {
  const store = new Map<string, string>();
  return {
    agentId: "agent-strategy-test",
    character: { name: "Eliza", settings: { secrets: {} }, secrets: {} },
    getSetting: (key: string) => store.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as IAgentRuntime;
}

const STRATEGY_KEYS = [
  "DEFENSE_STRATEGY_CURRENT",
  "DEFENSE_STRATEGY_BEST",
  "DEFENSE_STRATEGY_HISTORY",
  "DEFENSE_AUTO_PLAY",
];

beforeEach(() => {
  resetInMemoryStateForTests();
  for (const key of STRATEGY_KEYS) delete process.env[key];
});

afterEach(() => {
  resetInMemoryStateForTests();
  for (const key of STRATEGY_KEYS) delete process.env[key];
});

function makeLanes() {
  return {
    top: { human: 5, orc: 8, frontline: 0 },
    mid: { human: 10, orc: 4, frontline: 0 },
    bot: { human: 6, orc: 6, frontline: 0 },
  };
}

describe("scoreStrategy", () => {
  it("returns 0 when no ticks were tracked", () => {
    expect(
      scoreStrategy({
        ticksTracked: 0,
        ticksAlive: 0,
        levelStart: 1,
        levelEnd: 1,
        abilitiesLearned: 0,
        laneControlSum: 0,
        lastReviewedAt: 0,
      }),
    ).toBe(0);
  });

  it("weights survival 40%, level gain 30%, lane control 30%", () => {
    // 100% survival, +5 levels (capped at 1.0), avgLaneControl 0 → (0+50)/100 = 0.5.
    const score = scoreStrategy({
      ticksTracked: 10,
      ticksAlive: 10,
      levelStart: 1,
      levelEnd: 6,
      abilitiesLearned: 3,
      laneControlSum: 0,
      lastReviewedAt: 0,
    });
    // 0.4*1 + 0.3*1 + 0.3*0.5 = 0.85
    expect(score).toBeCloseTo(0.85, 5);
  });
});

describe("pickAbility", () => {
  it("returns the first priority ability present in the choices", () => {
    expect(
      pickAbility(["cleave", "fireball", "thorns"], ["tornado", "fireball"]),
    ).toBe("fireball");
  });

  it("falls back to the first choice when no priority matches", () => {
    expect(pickAbility(["cleave", "thorns"], ["fireball", "tornado"])).toBe(
      "cleave",
    );
  });

  it("returns undefined when there are no choices", () => {
    expect(pickAbility([], ["fireball"])).toBeUndefined();
  });
});

describe("findWeakestAlliedLane", () => {
  it("finds the lane with the worst human differential for a human hero", () => {
    // human-orc diffs: top -3, mid +6, bot 0 → weakest = top.
    const state = {
      tick: 1,
      agents: {},
      lanes: makeLanes(),
      towers: [],
      bases: {},
      heroes: [],
      winner: null,
    };
    expect(findWeakestAlliedLane(state, "human")).toBe("top");
  });

  it("finds the lane with the worst orc differential for an orc hero", () => {
    // orc-human diffs: top +3, mid -6, bot 0 → weakest = mid.
    const state = {
      tick: 1,
      agents: {},
      lanes: makeLanes(),
      towers: [],
      bases: {},
      heroes: [],
      winner: null,
    };
    expect(findWeakestAlliedLane(state, "orc")).toBe("mid");
  });
});

describe("parseStrategyUpdate", () => {
  const base: GameStrategy = {
    version: 4,
    heroClass: "mage",
    preferredLane: "mid",
    recallThreshold: 0.25,
    abilityPriority: ["fireball"],
    laneReinforcementThreshold: 3,
    metrics: {
      ticksTracked: 0,
      ticksAlive: 0,
      levelStart: 1,
      levelEnd: 1,
      abilitiesLearned: 0,
      laneControlSum: 0,
      lastReviewedAt: 0,
    },
  };

  it("applies a {strategy:{...}} JSON update, clamps recallThreshold, bumps version", () => {
    const next = parseStrategyUpdate(
      JSON.stringify({
        strategy: {
          heroClass: "melee",
          preferredLane: "bottom",
          recallThreshold: 5,
          abilityPriority: ["cleave", 7, "thorns"],
          laneReinforcementThreshold: -2,
        },
      }),
      base,
    );

    expect(next).not.toBeNull();
    expect(next?.heroClass).toBe("melee");
    expect(next?.preferredLane).toBe("bot"); // "bottom" normalized
    expect(next?.recallThreshold).toBe(1); // clamped to [0,1]
    expect(next?.abilityPriority).toEqual(["cleave", "thorns"]); // non-strings dropped
    expect(next?.laneReinforcementThreshold).toBe(0); // clamped to >= 0
    expect(next?.version).toBe(5); // bumped
  });

  it("returns null for plain text and for JSON without a strategy key", () => {
    expect(parseStrategyUpdate("recall to base", base)).toBeNull();
    expect(parseStrategyUpdate('{"foo":1}', base)).toBeNull();
    expect(parseStrategyUpdate("{ not json", base)).toBeNull();
  });
});

describe("isAutoPlayActive", () => {
  it("reads the persisted DEFENSE_AUTO_PLAY setting", () => {
    const runtime = makeRuntime();
    expect(isAutoPlayActive(runtime)).toBe(false);
    runtime.setSetting?.("DEFENSE_AUTO_PLAY", "1");
    expect(isAutoPlayActive(runtime)).toBe(true);
  });

  it("returns false when there is no runtime/agentId", () => {
    expect(isAutoPlayActive(null)).toBe(false);
  });
});

describe("runStrategyReview", () => {
  function withMetrics(
    runtime: IAgentRuntime,
    metrics: Partial<GameStrategy["metrics"]>,
  ): void {
    const current = resolveStrategy(runtime);
    persistStrategy(runtime, {
      ...current,
      metrics: { ...current.metrics, ...metrics },
    });
  }

  it("promotes the current strategy to best when it scores higher, then bumps version", () => {
    const runtime = makeRuntime();
    // Strong current run: 100% survival, +4 levels.
    withMetrics(runtime, {
      ticksTracked: 10,
      ticksAlive: 10,
      levelStart: 1,
      levelEnd: 5,
    });
    expect(resolveBestStrategy(runtime)).toBeNull();

    runStrategyReview(runtime);

    const best = resolveBestStrategy(runtime);
    expect(best).not.toBeNull();
    expect(
      scoreStrategy(best?.metrics ?? resolveStrategy(runtime).metrics),
    ).toBeGreaterThan(0);
    // Version bumped and metrics reset for the next cycle.
    const next = resolveStrategy(runtime);
    expect(next.version).toBe(2);
    expect(next.metrics.ticksTracked).toBe(0);
    expect(next.metrics.levelStart).toBe(5); // carried from prior levelEnd
  });

  it("reverts current strategy params to best when underperforming", () => {
    const runtime = makeRuntime();
    // Seed a strong BEST (mage/mid, recall 0.25) directly.
    const strongBest: GameStrategy = {
      ...resolveStrategy(runtime),
      heroClass: "mage",
      preferredLane: "mid",
      recallThreshold: 0.25,
      abilityPriority: ["fireball", "tornado"],
      laneReinforcementThreshold: 3,
      metrics: {
        ticksTracked: 10,
        ticksAlive: 10,
        levelStart: 1,
        levelEnd: 6,
        abilitiesLearned: 4,
        laneControlSum: 200,
        lastReviewedAt: 0,
      },
    };
    persistBestStrategy(runtime, strongBest);

    // Make the CURRENT a poorly-performing melee/top strategy.
    persistStrategy(runtime, {
      ...resolveStrategy(runtime),
      heroClass: "melee",
      preferredLane: "top",
      recallThreshold: 0.5,
      abilityPriority: ["cleave"],
      laneReinforcementThreshold: 1,
      metrics: {
        ticksTracked: 10,
        ticksAlive: 1,
        levelStart: 1,
        levelEnd: 1,
        abilitiesLearned: 0,
        laneControlSum: -200,
        lastReviewedAt: 0,
      },
    });

    runStrategyReview(runtime);

    // Current underperformed best by > 0.05 → params reverted to best.
    const next = resolveStrategy(runtime);
    expect(next.heroClass).toBe("mage");
    expect(next.preferredLane).toBe("mid");
    expect(next.recallThreshold).toBe(0.25);
    expect(next.abilityPriority).toEqual(["fireball", "tornado"]);
    expect(next.laneReinforcementThreshold).toBe(3);
  });
});
