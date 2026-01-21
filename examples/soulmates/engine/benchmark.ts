import { runEngineTick } from "./engine";
import { generatePersonas } from "./generator";
import { createDefaultLlmProvider } from "./llm";
import { createDefaultLocationProvider } from "./locations";
import type {
  DomainMode,
  EngineOptions,
  EngineState,
  MatchRecord,
  Persona,
} from "./types";

export interface BenchmarkCase {
  id: string;
  name: string;
  description: string;
  personas: Persona[];
  expectedMatches: ExpectedMatch[];
  domain: DomainMode;
}

export interface ExpectedMatch {
  personaAId: number;
  personaBId: number;
  shouldMatch: boolean;
  reason: string;
  minScore?: number;
  maxScore?: number;
}

export interface BenchmarkResult {
  caseId: string;
  caseName: string;
  totalExpected: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  matches: MatchRecord[];
  errors: string[];
}

export const createBenchmarkPersonas = (): BenchmarkCase[] => {
  const now = "2026-01-19T00:00:00.000Z";

  // Generate 30 complete personas as base
  const base = generatePersonas({ seed: 20000, count: 30, now });

  const cases: BenchmarkCase[] = [];

  // Case 1: Business Match (we know business works from earlier test)
  const biz0 = { ...base[0], id: 0 };
  const biz1 = { ...base[1], id: 1 };
  biz0.domains = ["business"];
  biz1.domains = ["business"];
  biz0.general.location.city = "San Francisco";
  biz1.general.location.city = "San Francisco";
  if (biz0.domainProfiles.business && biz1.domainProfiles.business) {
    biz0.domainProfiles.business.seekingRoles = ["sales", "marketing"];
    biz1.domainProfiles.business.roles = ["sales", "marketing"];
    biz1.domainProfiles.business.seekingRoles = ["technical", "engineering"];
    biz0.domainProfiles.business.roles = ["technical", "engineering"];
  }
  cases.push({
    id: "business-complementary",
    name: "Business: Complementary Co-founders",
    description: "Technical and business roles that complement each other",
    domain: "business",
    personas: [biz0, biz1],
    expectedMatches: [
      {
        personaAId: 0,
        personaBId: 1,
        shouldMatch: true,
        reason: "Complementary roles and skills",
        minScore: 50,
      },
    ],
  });

  // Case 2: Dealbreaker (age mismatch)
  const deal0 = { ...base[5], id: 0 };
  const deal1 = { ...base[6], id: 1 };
  deal0.domains = ["dating"];
  deal1.domains = ["dating"];
  deal0.general.age = 25;
  deal0.general.genderIdentity = "woman";
  deal0.general.location.city = "San Francisco";
  deal1.general.age = 45;
  deal1.general.genderIdentity = "man";
  deal1.general.location.city = "New York";
  if (deal0.domainProfiles.dating) {
    deal0.domainProfiles.dating.datingPreferences.preferredAgeMin = 28;
    deal0.domainProfiles.dating.datingPreferences.preferredAgeMax = 35;
  }
  cases.push({
    id: "dating-dealbreaker",
    name: "Dating: Dealbreaker Mismatch",
    description: "Age and location mismatches",
    domain: "dating",
    personas: [deal0, deal1],
    expectedMatches: [
      {
        personaAId: 0,
        personaBId: 1,
        shouldMatch: false,
        reason: "Age outside preferences and different cities",
      },
    ],
  });

  // Case 3: Low Reliability
  const rel0 = { ...base[10], id: 0 };
  const rel1 = { ...base[11], id: 1 };
  rel0.domains = ["dating"];
  rel1.domains = ["dating"];
  rel0.general.location.city = "San Francisco";
  rel1.general.location.city = "San Francisco";
  rel0.reliability.score = 0.9;
  rel1.reliability.score = 0.15;
  rel1.reliability.ghostCount = 3;
  rel1.reliability.noShowCount = 2;
  cases.push({
    id: "reliability-penalty",
    name: "Dating: Low Reliability Blocks Match",
    description: "One persona has very low reliability",
    domain: "dating",
    personas: [rel0, rel1],
    expectedMatches: [
      {
        personaAId: 0,
        personaBId: 1,
        shouldMatch: false,
        reason: "Reliability score below minimum threshold",
      },
    ],
  });

  // Case 4: Red Flags
  const red0 = { ...base[15], id: 0 };
  const red1 = { ...base[16], id: 1 };
  red0.domains = ["dating"];
  red1.domains = ["dating"];
  red0.general.location.city = "San Francisco";
  red1.general.location.city = "San Francisco";
  red0.profile.feedbackSummary.redFlagTags = [];
  red1.profile.feedbackSummary.redFlagTags = [
    "harassment",
    "deception",
    "safety_concern",
  ];
  cases.push({
    id: "red-flags-block",
    name: "Dating: Multiple Red Flags Block Match",
    description: "One persona has multiple red flags",
    domain: "dating",
    personas: [red0, red1],
    expectedMatches: [
      {
        personaAId: 0,
        personaBId: 1,
        shouldMatch: false,
        reason: "Multiple red flags present",
      },
    ],
  });

  return cases;
};

export const runBenchmark = async (
  benchmarkCase: BenchmarkCase,
): Promise<BenchmarkResult> => {
  const state: EngineState = {
    personas: benchmarkCase.personas,
    feedbackQueue: [],
    matchGraph: {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "feedback_positive",
          createdAt: "2026-01-18T00:00:00.000Z",
        },
        {
          from: 1,
          to: 0,
          weight: 0.8,
          type: "feedback_positive",
          createdAt: "2026-01-18T00:00:00.000Z",
        },
      ],
    },
    matches: [],
    meetings: [],
    safetyReports: [],
    communities: [],
    credits: [],
    messages: [],
  };

  const options: EngineOptions = {
    matchDomains: [benchmarkCase.domain],
    batchSize: benchmarkCase.personas.length,
    maxCandidates: 50,
    smallPassTopK: 10,
    largePassTopK: 3,
    graphHops: 2,
    matchCooldownDays: 30,
    reliabilityWeight: 0.3,
    requireSharedInterests: benchmarkCase.domain === "friendship",
    requireSameCity: benchmarkCase.domain !== "business",
    recentMatchWindow: 7,
    negativeFeedbackCooldownDays: 14,
    minAvailabilityMinutes: 120,
    processFeedbackLimit: 50,
    processConversationLimit: 50,
    autoScheduleMatches: false,
    now: "2026-01-19T00:00:00.000Z",
  };

  const result = await runEngineTick(state, options, {
    llm: createDefaultLlmProvider(),
    locationProvider: createDefaultLocationProvider(),
  });

  const actualMatches = result.matchesCreated;
  const expectedPositives = new Set(
    benchmarkCase.expectedMatches
      .filter((em) => em.shouldMatch)
      .map((em) => `${em.personaAId}-${em.personaBId}`),
  );

  const expectedNegatives = new Set(
    benchmarkCase.expectedMatches
      .filter((em) => !em.shouldMatch)
      .map((em) => `${em.personaAId}-${em.personaBId}`),
  );

  let truePositives = 0;
  let falsePositives = 0;
  const errors: string[] = [];

  for (const match of actualMatches) {
    const pairKey = `${Math.min(match.personaA, match.personaB)}-${Math.max(match.personaA, match.personaB)}`;

    if (expectedPositives.has(pairKey)) {
      truePositives++;
      const expected = benchmarkCase.expectedMatches.find(
        (em) =>
          (em.personaAId === match.personaA &&
            em.personaBId === match.personaB) ||
          (em.personaAId === match.personaB &&
            em.personaBId === match.personaA),
      );
      if (expected?.minScore && match.assessment.score < expected.minScore) {
        errors.push(
          `Match ${pairKey} score ${match.assessment.score} below expected minimum ${expected.minScore}`,
        );
      }
      if (expected?.maxScore && match.assessment.score > expected.maxScore) {
        errors.push(
          `Match ${pairKey} score ${match.assessment.score} above expected maximum ${expected.maxScore}`,
        );
      }
    } else if (expectedNegatives.has(pairKey)) {
      falsePositives++;
      const expected = benchmarkCase.expectedMatches.find(
        (em) =>
          (em.personaAId === match.personaA &&
            em.personaBId === match.personaB) ||
          (em.personaAId === match.personaB &&
            em.personaBId === match.personaA),
      );
      errors.push(
        `False positive: ${pairKey} matched (score: ${match.assessment.score}) but should not. Reason: ${expected?.reason}`,
      );
    } else {
      falsePositives++;
      errors.push(
        `Unexpected match: ${pairKey} with score ${match.assessment.score}`,
      );
    }
  }

  const falseNegatives = expectedPositives.size - truePositives;
  const trueNegatives = expectedNegatives.size - falsePositives;

  const precision =
    truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;
  const recall =
    truePositives + falseNegatives > 0
      ? truePositives / (truePositives + falseNegatives)
      : 0;
  const f1Score =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  const accuracy =
    (truePositives + trueNegatives) /
    (truePositives + trueNegatives + falsePositives + falseNegatives);

  for (const expected of benchmarkCase.expectedMatches.filter(
    (em) => em.shouldMatch,
  )) {
    const pairKey = `${expected.personaAId}-${expected.personaBId}`;
    const found = actualMatches.some(
      (m) =>
        (m.personaA === expected.personaAId &&
          m.personaB === expected.personaBId) ||
        (m.personaA === expected.personaBId &&
          m.personaB === expected.personaAId),
    );
    if (!found) {
      errors.push(
        `False negative: Expected match ${pairKey} not found. Reason: ${expected.reason}`,
      );
    }
  }

  return {
    caseId: benchmarkCase.id,
    caseName: benchmarkCase.name,
    totalExpected: benchmarkCase.expectedMatches.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision,
    recall,
    f1Score,
    accuracy,
    matches: actualMatches,
    errors,
  };
};

export const runAllBenchmarks = async (): Promise<BenchmarkResult[]> => {
  const cases = createBenchmarkPersonas();
  const results: BenchmarkResult[] = [];

  for (const benchmarkCase of cases) {
    const result = await runBenchmark(benchmarkCase);
    results.push(result);
  }

  return results;
};

export const printBenchmarkReport = (results: BenchmarkResult[]): void => {
  console.log("\n=== Matching Engine Benchmark Report ===\n");

  let totalTP = 0;
  let totalFP = 0;
  let totalTN = 0;
  let totalFN = 0;

  for (const result of results) {
    console.log(`📊 ${result.caseName}`);
    console.log(`   ID: ${result.caseId}`);
    console.log(`   Precision: ${(result.precision * 100).toFixed(1)}%`);
    console.log(`   Recall: ${(result.recall * 100).toFixed(1)}%`);
    console.log(`   F1 Score: ${(result.f1Score * 100).toFixed(1)}%`);
    console.log(`   Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);
    console.log(
      `   TP: ${result.truePositives}, FP: ${result.falsePositives}, TN: ${result.trueNegatives}, FN: ${result.falseNegatives}`,
    );

    if (result.errors.length > 0) {
      console.log(`   ⚠️  Errors:`);
      for (const error of result.errors) {
        console.log(`      - ${error}`);
      }
    } else {
      console.log(`   ✅ All checks passed`);
    }
    console.log();

    totalTP += result.truePositives;
    totalFP += result.falsePositives;
    totalTN += result.trueNegatives;
    totalFN += result.falseNegatives;
  }

  const overallPrecision =
    totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0;
  const overallRecall =
    totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0;
  const overallF1 =
    overallPrecision + overallRecall > 0
      ? (2 * overallPrecision * overallRecall) /
        (overallPrecision + overallRecall)
      : 0;
  const overallAccuracy =
    (totalTP + totalTN) / (totalTP + totalTN + totalFP + totalFN);

  console.log("=== Overall Performance ===");
  console.log(`Precision: ${(overallPrecision * 100).toFixed(1)}%`);
  console.log(`Recall: ${(overallRecall * 100).toFixed(1)}%`);
  console.log(`F1 Score: ${(overallF1 * 100).toFixed(1)}%`);
  console.log(`Accuracy: ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log(
    `Total: TP=${totalTP}, FP=${totalFP}, TN=${totalTN}, FN=${totalFN}`,
  );
  console.log();
};
