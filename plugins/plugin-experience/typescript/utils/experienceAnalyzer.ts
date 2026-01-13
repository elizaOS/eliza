import type { Experience } from "../types";
import { ExperienceType, OutcomeType } from "../types";

export interface ExperienceAnalysis {
  isSignificant: boolean;
  learning?: string;
  confidence: number;
  relatedExperiences?: string[];
  actionableInsights?: string[];
}

export async function analyzeExperience(
  partialExperience: Partial<Experience>,
  recentExperiences: Experience[]
): Promise<ExperienceAnalysis> {
  // Check if this experience represents something new or significant
  const similarExperiences = findSimilarExperiences(partialExperience, recentExperiences);

  // If we've seen this exact pattern many times, it's less significant
  if (similarExperiences.length > 5) {
    return {
      isSignificant: false,
      confidence: 0.3,
    };
  }

  // Check for contradictions with previous experiences
  const contradictions = findContradictions(partialExperience, recentExperiences);
  if (contradictions.length > 0) {
    const firstContradiction = contradictions[0];
    if (firstContradiction) {
      const currentResult = partialExperience.result ?? "unknown result";
      const previousResult = firstContradiction.result ?? "unknown result";

      return {
        isSignificant: true,
        learning: `New outcome contradicts previous experience: ${currentResult} vs ${previousResult}`,
        confidence: 0.8,
        relatedExperiences: contradictions.map((e) => e.id),
        actionableInsights: ["Update strategy based on new information"],
      };
    }
  }

  // Check if this is a first-time action
  const isFirstTime = !recentExperiences.some((e) => e.action === partialExperience.action);
  if (isFirstTime && partialExperience.type === ExperienceType.SUCCESS) {
    return {
      isSignificant: true,
      learning: `Successfully completed new action: ${partialExperience.action}`,
      confidence: 0.7,
      actionableInsights: [`${partialExperience.action} is now a known capability`],
    };
  }

  // Check for failure patterns
  if (partialExperience.type === ExperienceType.FAILURE) {
    const failurePattern = detectFailurePattern(partialExperience, recentExperiences);
    if (failurePattern) {
      return {
        isSignificant: true,
        learning: failurePattern.learning,
        confidence: 0.9,
        relatedExperiences: failurePattern.relatedIds,
        actionableInsights: failurePattern.insights,
      };
    }
  }

  // Default: Record if confidence is high enough
  return {
    isSignificant: partialExperience.type !== ExperienceType.SUCCESS || Math.random() > 0.7,
    confidence: 0.5,
  };
}

function findSimilarExperiences(
  partial: Partial<Experience>,
  experiences: Experience[]
): Experience[] {
  return experiences.filter(
    (e) =>
      e.action === partial.action &&
      e.type === partial.type &&
      similarContext(e.context, partial.context || "")
  );
}

function findContradictions(partial: Partial<Experience>, experiences: Experience[]): Experience[] {
  return experiences.filter(
    (e) => e.action === partial.action && e.context === partial.context && e.type !== partial.type
  );
}

function similarContext(context1: string, context2: string): boolean {
  // Simple similarity check - could be enhanced with better NLP
  const words1 = context1.toLowerCase().split(/\s+/);
  const words2 = context2.toLowerCase().split(/\s+/);
  const commonWords = words1.filter((w) => words2.includes(w));
  return commonWords.length / Math.max(words1.length, words2.length) > 0.5;
}

interface FailurePattern {
  learning: string;
  relatedIds: string[];
  insights: string[];
}

function detectFailurePattern(
  partial: Partial<Experience>,
  experiences: Experience[]
): FailurePattern | null {
  const recentFailures = experiences.filter((e) => e.type === ExperienceType.FAILURE).slice(0, 10);

  // Check for repeated failures
  const sameActionFailures = recentFailures.filter((e) => e.action === partial.action);
  if (sameActionFailures.length >= 3) {
    return {
      learning: `Action ${partial.action} has failed ${sameActionFailures.length} times recently. Need alternative approach.`,
      relatedIds: sameActionFailures.map((e) => e.id),
      insights: [
        `Avoid ${partial.action} until root cause is addressed`,
        "Consider alternative actions to achieve the same goal",
      ],
    };
  }

  // Check for cascading failures
  if (recentFailures.length >= 5) {
    return {
      learning: "Multiple consecutive failures detected. System may be in unstable state.",
      relatedIds: recentFailures.slice(0, 5).map((e) => e.id),
      insights: ["Pause and reassess current approach", "Check system health and dependencies"],
    };
  }

  return null;
}

export async function detectPatterns(experiences: Experience[]): Promise<
  Array<{
    description: string;
    frequency: number;
    experiences: string[];
    significance: "low" | "medium" | "high";
  }>
> {
  const patterns: Array<{
    description: string;
    frequency: number;
    experiences: string[];
    significance: "low" | "medium" | "high";
  }> = [];

  // Group experiences by action
  const actionGroups = new Map<string, Experience[]>();
  experiences.forEach((exp) => {
    const group = actionGroups.get(exp.action) || [];
    group.push(exp);
    actionGroups.set(exp.action, group);
  });

  // Detect success/failure patterns
  actionGroups.forEach((group, action) => {
    const successRate =
      group.filter((e) => e.outcome === OutcomeType.POSITIVE).length / group.length;

    if (group.length >= 5) {
      if (successRate < 0.3) {
        patterns.push({
          description: `Action ${action} has low success rate (${Math.round(successRate * 100)}%)`,
          frequency: group.length,
          experiences: group.map((e) => e.id),
          significance: "high",
        });
      } else if (successRate > 0.9) {
        patterns.push({
          description: `Action ${action} is highly reliable (${Math.round(successRate * 100)}% success)`,
          frequency: group.length,
          experiences: group.map((e) => e.id),
          significance: "medium",
        });
      }
    }
  });

  // Detect time-based patterns
  const hourlyGroups = groupByHour(experiences);
  hourlyGroups.forEach((group, hour) => {
    if (group.length >= 10) {
      const failureRate =
        group.filter((e) => e.outcome === OutcomeType.NEGATIVE).length / group.length;
      if (failureRate > 0.5) {
        patterns.push({
          description: `Higher failure rate during hour ${hour} (${Math.round(failureRate * 100)}%)`,
          frequency: group.length,
          experiences: group.slice(0, 5).map((e) => e.id),
          significance: "medium",
        });
      }
    }
  });

  // Detect learning velocity
  const learningExperiences = experiences.filter(
    (e) => e.type === ExperienceType.DISCOVERY || e.type === ExperienceType.LEARNING
  );

  if (learningExperiences.length >= 3) {
    const recentLearning = learningExperiences.slice(0, 10);
    const timeDiffs: number[] = [];
    for (let i = 1; i < recentLearning.length; i++) {
      const previous = recentLearning[i - 1];
      const current = recentLearning[i];
      if (!previous || !current) {
        continue;
      }
      timeDiffs.push(previous.createdAt - current.createdAt);
    }
    const avgTimeBetweenLearning =
      timeDiffs.length > 0 ? timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length : 0;

    patterns.push({
      description: `Learning new things every ${Math.round(avgTimeBetweenLearning / 60000)} minutes on average`,
      frequency: learningExperiences.length,
      experiences: recentLearning.map((e) => e.id),
      significance: "medium",
    });
  }

  return patterns;
}

function groupByHour(experiences: Experience[]): Map<number, Experience[]> {
  const groups = new Map<number, Experience[]>();

  experiences.forEach((exp) => {
    const hour = new Date(exp.createdAt).getHours();
    const group = groups.get(hour) || [];
    group.push(exp);
    groups.set(hour, group);
  });

  return groups;
}
