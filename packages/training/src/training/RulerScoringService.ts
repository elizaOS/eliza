/**
 * RULER Scoring Service
 *
 * Implements RULER (Relative Universal LLM-Elicited Rewards) using LLM-as-judge.
 *
 * Key features:
 * - Groups trajectories by scenarioId for relative comparison
 * - Uses LLM judge to score trajectories relative to each other (0-1)
 * - Injects game context (P&L, episode length, actions) into judge prompt
 * - Deduplicates common message prefixes to save tokens
 * - Works with any LiteLLM-compatible provider (Groq, OpenAI, etc.)
 *
 * Based on: https://art.openpipe.ai/fundamentals/ruler
 */

import { getTrainingDataAdapter, type JsonValue, type UUID } from "../adapter";

/** Cast string to UUID (replaces @elizaos/core asUUID) */
function asUUID(id: string): UUID {
  return id as UUID;
}

import { v4 as uuidv4 } from "uuid";
import {
  getLLMCaller,
  getToTrainingMessages,
  type TrajectoryForTraining,
  type TrajectoryStepForTraining,
} from "../dependencies";
import { getRubric, sanitizeArchetype } from "../rubrics";
import { logger, splitIntoBatches } from "../utils";
import type { TrajectoryStep as TrainingTrajectoryStep } from "./types";

// Use types from dependencies
type RichTrajectory = TrajectoryForTraining;
type TrajectoryStep = TrajectoryStepForTraining;

export interface RulerScore {
  trajectoryId: string;
  overallScore: number;
  reasoning: string;
  scoredAt: Date;
}

export interface MarketOutcomes {
  stocks: Array<{ ticker: string; changePercent: number }>;
  predictions: Array<{ marketId: string; outcome: "YES" | "NO" }>;
}

interface TrajectoryScore {
  trajectory_id: string;
  explanation: string;
  score: number;
}

interface RulerResponse {
  scores: TrajectoryScore[];
}

/**
 * Default RULER rubric - works well for most RL tasks
 */
const DEFAULT_RUBRIC = `
- A trajectory that achieves its goal should always get a significantly higher score than a trajectory that does not achieve its goal.
- A trajectory that achieves its goal more efficiently (eg. by avoiding unproductive detours) should get a higher score than a trajectory that achieves its goal less efficiently.
- If one trajectory is only slightly better than another, the difference in scores should be small. If it is significantly better, the difference in scores should be large.
- You may give some partial credit for a trajectory that makes progress towards its goal but does not complete it.
`;

export class RulerScoringService {
  private readonly minGroupSize = 2; // Minimum trajectories per group for comparison
  private readonly maxGroupSize = 8; // Optimal group size per RULER docs

  /**
   * Score trajectories using RULER (LLM-as-judge with relative comparison)
   *
   * Groups trajectories by scenarioId and scores them relative to each other.
   * This is the proper RULER implementation - not simple heuristics!
   *
   * @param trajectoryIds - Optional: specific trajectory IDs to score. If not provided, scores all unscored trajectories.
   * @returns Number of trajectories successfully scored
   */
  async scoreTrajectories(trajectoryIds?: string[]): Promise<number> {
    const trajectoriesResult = await this.getTrajectoriesToScore(trajectoryIds);

    if (trajectoriesResult.length === 0) {
      logger.info("No trajectories to score", {}, "RulerScoring");
      return 0;
    }

    const groups = this.groupByScenario(trajectoriesResult);

    logger.info(
      "Grouped trajectories for RULER scoring",
      {
        totalTrajectories: trajectoriesResult.length,
        groups: groups.length,
        avgGroupSize:
          groups.length > 0 ? trajectoriesResult.length / groups.length : 0,
      },
      "RulerScoring",
    );

    let totalScored = 0;

    for (const group of groups) {
      if (group.trajectories.length < this.minGroupSize) {
        logger.warn(
          "Skipping group with insufficient trajectories",
          {
            scenarioId: group.scenarioId,
            count: group.trajectories.length,
            minRequired: this.minGroupSize,
          },
          "RulerScoring",
        );
        continue;
      }

      const batches = splitIntoBatches(group.trajectories, this.maxGroupSize);

      for (const batch of batches) {
        const scored = await this.scoreGroup(batch, group.scenarioId);
        totalScored += scored;
      }
    }

    logger.info(
      "RULER scoring complete",
      {
        totalScored,
        totalTrajectories: trajectoriesResult.length,
      },
      "RulerScoring",
    );

    return totalScored;
  }

  /**
   * Score a single trajectory (for backward compatibility)
   *
   * Note: RULER works best with groups, so this finds other trajectories
   * in the same scenario and scores them together.
   */
  async scoreTrajectory(trajectoryId: string): Promise<RulerScore | null> {
    const scored = await this.scoreTrajectories([trajectoryId]);
    if (scored === 0) {
      return null;
    }

    const updated =
      await getTrainingDataAdapter().getTrajectoryById(trajectoryId);

    if (!updated || updated.aiJudgeReward === null) {
      return null;
    }

    return {
      trajectoryId: updated.trajectoryId,
      overallScore: updated.aiJudgeReward,
      reasoning: updated.aiJudgeReasoning || "",
      scoredAt: updated.judgedAt || new Date(),
    };
  }

  /**
   * Score a group of trajectories using RULER
   *
   * This is the core RULER implementation:
   * 1. Convert trajectories to message format
   * 2. Extract common prefix (deduplication)
   * 3. Build judge prompt with context (P&L, episode length, etc.)
   * 4. Call LLM judge to score trajectories relative to each other
   * 5. Save scores to database
   */
  private async scoreGroup(
    trajectoriesData: Array<{
      trajectoryId: string;
      stepsJson: string | null;
      scenarioId: string | null;
      finalPnL: number | null;
      episodeLength: number | null;
      archetype: string | null;
    }>,
    scenarioId: string,
  ): Promise<number> {
    const richTrajectories: Array<{
      traj: RichTrajectory;
      messages: Array<{ role: string; content: string }>;
      archetype: string;
    }> = [];

    for (const dbTraj of trajectoriesData) {
      if (
        !dbTraj.stepsJson ||
        dbTraj.stepsJson === "null" ||
        dbTraj.stepsJson === "[]"
      ) {
        logger.warn(
          "Skipping trajectory with invalid stepsJson",
          {
            trajectoryId: dbTraj.trajectoryId,
          },
          "RulerScoring",
        );
        continue;
      }

      const steps = JSON.parse(dbTraj.stepsJson) as TrainingTrajectoryStep[];

      const stepTimestamp = Date.now();
      const richTraj: RichTrajectory = {
        trajectoryId: asUUID(dbTraj.trajectoryId),
        agentId: asUUID(uuidv4()),
        startTime: 0,
        endTime: 0,
        durationMs: 0,
        scenarioId: dbTraj.scenarioId || undefined,
        steps: steps.map(
          (s, idx): TrajectoryStep => ({
            stepId: asUUID(uuidv4()),
            stepNumber: idx,
            timestamp: s.timestamp || stepTimestamp + idx,
            environmentState: {
              ...s.environmentState,
              timestamp: s.timestamp || stepTimestamp + idx,
              agentPoints:
                (s.environmentState as { agentPoints?: number }).agentPoints ??
                0,
            },
            observation: {},
            providerAccesses: (s.providerAccesses || []).map((p) => ({
              providerId: uuidv4(),
              providerName: p.providerName,
              timestamp: s.timestamp || stepTimestamp + idx,
              query: p.data as Record<string, JsonValue>,
              data: p.data,
              purpose: p.purpose,
            })),
            llmCalls: (s.llmCalls || []).map((l) => ({
              callId: uuidv4(),
              timestamp: s.timestamp || stepTimestamp + idx,
              model: l.model,
              modelVersion: l.modelVersion,
              systemPrompt: l.systemPrompt,
              userPrompt: l.userPrompt,
              response: l.response,
              reasoning: l.reasoning,
              temperature: l.temperature,
              maxTokens: l.maxTokens,
              latencyMs: l.latencyMs,
              purpose: l.purpose as
                | "action"
                | "reasoning"
                | "evaluation"
                | "response"
                | "other",
              actionType: l.actionType,
            })),
            action: {
              attemptId: uuidv4(),
              timestamp: s.timestamp || stepTimestamp + idx,
              actionType: s.action.actionType,
              actionName: s.action.actionType,
              parameters: s.action.parameters,
              reasoning: s.action.reasoning,
              success: s.action.success,
              result: s.action.result,
              error: s.action.error,
            },
            reward: s.reward,
            done: idx === steps.length - 1,
            metadata: {},
          }),
        ),
        totalReward: steps.reduce((sum, s) => sum + s.reward, 0),
        rewardComponents: {
          environmentReward: steps.reduce((sum, s) => sum + s.reward, 0),
        },
        metrics: {
          episodeLength: dbTraj.episodeLength || steps.length,
          finalStatus: "completed",
          finalPnL: dbTraj.finalPnL || undefined,
        },
        metadata: {
          isTrainingData: true,
        },
      };

      const toARTMessages = getToTrainingMessages();
      const messages = toARTMessages(richTraj);
      // Sanitize archetype to prevent prompt injection and handle null/empty values
      const archetype = sanitizeArchetype(dbTraj.archetype);
      richTrajectories.push({ traj: richTraj, messages, archetype });
    }

    if (richTrajectories.length < this.minGroupSize) {
      logger.warn(
        "Insufficient valid trajectories in group",
        {
          scenarioId,
          validCount: richTrajectories.length,
        },
        "RulerScoring",
      );
      return 0;
    }

    const commonPrefix = this.extractCommonPrefix(
      richTrajectories.map((rt) => rt.messages),
    );

    const judgePrompt = this.buildJudgePrompt(
      richTrajectories,
      commonPrefix,
      scenarioId,
    );

    const judgeResponse = await this.callJudge(judgePrompt);

    if (
      !judgeResponse ||
      judgeResponse.scores.length !== richTrajectories.length
    ) {
      logger.error(
        "Invalid judge response",
        {
          expectedScores: richTrajectories.length,
          receivedScores: judgeResponse?.scores.length || 0,
        },
        "RulerScoring",
      );
      return 0;
    }

    const scoreMap = new Map<string, TrajectoryScore>();
    for (const score of judgeResponse.scores) {
      scoreMap.set(score.trajectory_id, score);
    }

    let scored = 0;
    for (let i = 0; i < richTrajectories.length; i++) {
      const expectedTrajId = `trajectory-${i + 1}`;
      const scoreData = scoreMap.get(expectedTrajId);

      if (!scoreData) {
        logger.warn(
          "Judge did not return score for trajectory",
          {
            expectedTrajId,
            receivedIds: judgeResponse.scores.map((s) => s.trajectory_id),
          },
          "RulerScoring",
        );
        continue;
      }

      const trajectoryId = richTrajectories[i]?.traj.trajectoryId;

      await getTrainingDataAdapter().updateTrajectoryScore(
        trajectoryId,
        Math.max(0, Math.min(1, scoreData.score)),
        scoreData.explanation,
      );

      scored++;
    }

    logger.info(
      "Scored trajectory group",
      {
        scenarioId,
        scored,
        groupSize: richTrajectories.length,
      },
      "RulerScoring",
    );

    return scored;
  }

  /**
   * Build judge prompt with trajectory context
   *
   * Injects game knowledge (P&L, episode length, actions) into the prompt
   * so the judge can make informed relative comparisons.
   */
  private buildJudgePrompt(
    richTrajectories: Array<{
      traj: RichTrajectory;
      messages: Array<{ role: string; content: string }>;
      archetype: string;
    }>,
    commonPrefix: Array<{ role: string; content: string }>,
    scenarioId: string,
  ): string {
    // Build context section with game knowledge (injected into prompt)
    const contextParts: string[] = [];
    contextParts.push(`Scenario: ${scenarioId}`);
    contextParts.push(
      `\nTrajectory Performance Context (use this to inform your scoring):`,
    );

    for (let i = 0; i < richTrajectories.length; i++) {
      const rt = richTrajectories[i];
      if (!rt) continue;
      const trajId = `trajectory-${i + 1}`;

      contextParts.push(`\n${trajId}:`);
      contextParts.push(`  - Archetype: ${rt.archetype}`);
      contextParts.push(
        `  - Final P&L: $${rt.traj.metrics.finalPnL?.toFixed(2) || "0.00"}`,
      );
      contextParts.push(
        `  - Episode Length: ${rt.traj.metrics.episodeLength || 0} steps`,
      );
      contextParts.push(`  - Total Reward: ${rt.traj.totalReward.toFixed(2)}`);

      const actionTypes = rt.traj.steps
        .filter((s: TrajectoryStep): boolean => !!s.action)
        .map((s: TrajectoryStep): string => s.action?.actionType);
      const uniqueActions = [...new Set(actionTypes)];
      contextParts.push(
        `  - Actions Taken: ${uniqueActions.join(", ")} (${actionTypes.length} total)`,
      );

      // Add success/error info
      const errors = rt.traj.steps.filter(
        (s: TrajectoryStep): boolean => !!s.action && !s.action.success,
      ).length;
      const successRate =
        rt.traj.steps.length > 0
          ? (
              ((rt.traj.steps.length - errors) / rt.traj.steps.length) *
              100
            ).toFixed(1)
          : "0";
      contextParts.push(`  - Success Rate: ${successRate}%`);

      if (errors > 0) {
        contextParts.push(`  - Errors: ${errors}`);
      }
    }

    // Build trajectory messages (with deduplicated prefix)
    const trajectorySections: string[] = [];

    for (let i = 0; i < richTrajectories.length; i++) {
      const rt = richTrajectories[i];
      if (!rt) continue;
      const trajId = `trajectory-${i + 1}`;

      // Remove common prefix from messages
      const uniqueMessages = rt.messages.slice(commonPrefix.length);

      // Truncate very long messages to save tokens (keep last 20 messages max)
      const truncatedMessages = uniqueMessages.slice(-20);

      trajectorySections.push(`<trajectory id="${trajId}">`);
      trajectorySections.push(JSON.stringify(truncatedMessages, null, 2));
      trajectorySections.push(`</trajectory>`);
    }

    // Build full prompt
    const userContent =
      commonPrefix.length > 0
        ? `<context>\n${JSON.stringify(commonPrefix, null, 2)}\n</context>\n\n`
        : "";

    const prompt = `${userContent}${contextParts.join("\n")}\n\nTrajectories:\n\n${trajectorySections.join("\n\n")}`;

    // Determine archetype-specific rubric
    // If all trajectories share the same archetype, use that archetype's rubric
    // Otherwise, fall back to the default rubric
    const archetypes = [...new Set(richTrajectories.map((rt) => rt.archetype))];
    const isSingleArchetype =
      archetypes.length === 1 && archetypes[0] !== "default";
    const singleArchetype = archetypes[0];
    const rubric =
      isSingleArchetype && singleArchetype
        ? getRubric(singleArchetype)
        : DEFAULT_RUBRIC;
    const archetypeContext = isSingleArchetype
      ? `\n\nYou are evaluating ${archetypes[0]?.toUpperCase()} agents. Score them based on how well they embody that archetype's behavior and goals.`
      : archetypes.length > 1
        ? `\n\nNote: This group contains mixed archetypes (${archetypes.join(", ")}). Consider each agent's archetype when scoring.`
        : "";

    const systemPrompt = `You are an expert evaluator of AI agent performance. All trajectories below were given the same goal/scenario. Your job is to compare them and assign scores from 0 to 1 based on how well each trajectory achieved its goal.${archetypeContext}

Grading standards:
${rubric}

Important: Use the performance context provided (P&L, episode length, success rate, archetype) to inform your scoring, but also consider the quality of decision-making, efficiency, and goal achievement shown in the trajectory messages.`;

    return JSON.stringify({
      system: systemPrompt,
      user: prompt,
    });
  }

  /**
   * Call LLM judge to score trajectories
   *
   * Uses structured output format to ensure valid JSON response.
   */
  private async callJudge(promptJson: string): Promise<RulerResponse | null> {
    const promptData = JSON.parse(promptJson) as {
      system: string;
      user: string;
    };

    const structuredPrompt = `${promptData.user}

Please respond with ONLY a valid JSON object in this exact format:
{
  "scores": [
    {
      "trajectory_id": "trajectory-1",
      "explanation": "Brief explanation of score",
      "score": 0.85
    },
    {
      "trajectory_id": "trajectory-2",
      "explanation": "Brief explanation of score",
      "score": 0.65
    }
  ]
}

Return ONLY the JSON, no other text.`;

    const llmCaller = getLLMCaller();
    const response = await llmCaller.callGroqDirect({
      prompt: structuredPrompt,
      system: promptData.system,
      modelSize: "large",
      temperature: 0.3,
      maxTokens: 2000,
      actionType: "ruler_score_trajectories",
    });

    let jsonText = response.trim();
    jsonText = jsonText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error(
        "Judge response does not contain JSON",
        {
          response: response.substring(0, 500),
        },
        "RulerScoring",
      );
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as RulerResponse;

    if (!parsed.scores || !Array.isArray(parsed.scores)) {
      logger.error(
        "Invalid judge response structure",
        { parsed },
        "RulerScoring",
      );
      return null;
    }

    for (const score of parsed.scores) {
      if (score.score < 0 || score.score > 1) {
        score.score = Math.max(0, Math.min(1, score.score));
      }
    }

    return parsed;
  }

  /**
   * Extract common message prefix from trajectories
   *
   * RULER deduplicates common prefixes to save tokens.
   */
  private extractCommonPrefix(
    messageLists: Array<Array<{ role: string; content: string }>>,
  ): Array<{ role: string; content: string }> {
    if (messageLists.length === 0) return [];

    const first = messageLists[0];
    if (!first) return [];
    const prefix: Array<{ role: string; content: string }> = [];

    for (let i = 0; i < first.length; i++) {
      const msg = first[i];
      if (!msg) continue;
      const allMatch = messageLists.every(
        (msgs) =>
          msgs[i] &&
          msgs[i]?.role === msg.role &&
          msgs[i]?.content === msg.content,
      );

      if (allMatch) {
        prefix.push(msg);
      } else {
        break;
      }
    }

    return prefix;
  }

  /**
   * Group trajectories by scenarioId
   */
  private groupByScenario(
    trajectoriesData: Array<{
      trajectoryId: string;
      stepsJson: string | null;
      scenarioId: string | null;
      finalPnL: number | null;
      episodeLength: number | null;
      archetype: string | null;
    }>,
  ): Array<{ scenarioId: string; trajectories: typeof trajectoriesData }> {
    const groups = new Map<string, typeof trajectoriesData>();

    for (const traj of trajectoriesData) {
      const scenarioId = traj.scenarioId || "default";
      if (!groups.has(scenarioId)) {
        groups.set(scenarioId, []);
      }
      groups.get(scenarioId)?.push(traj);
    }

    return Array.from(groups.entries()).map(([scenarioId, trajs]) => ({
      scenarioId,
      trajectories: trajs,
    }));
  }

  /**
   * Get trajectories to score
   */
  private async getTrajectoriesToScore(trajectoryIds?: string[]) {
    const adapter = getTrainingDataAdapter();
    return await adapter.getUnscoredTrajectories(
      trajectoryIds && trajectoryIds.length > 0 ? { trajectoryIds } : undefined,
    );
  }

  /**
   * Score all unscored trajectories in a time window
   */
  async scoreWindow(windowId: string): Promise<number> {
    const trajectoryIds =
      await getTrainingDataAdapter().getUnscoredWindowTrajectoryIds(windowId);

    if (trajectoryIds.length === 0) {
      return 0;
    }

    return await this.scoreTrajectories(trajectoryIds);
  }
}

/**
 * Singleton instance of RulerScoringService
 */
export const rulerScoringService = new RulerScoringService();
