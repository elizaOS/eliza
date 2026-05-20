/**
 * Autonomous Coordinator
 *
 * Central orchestrator for all autonomous agent behaviors.
 * Eliminates duplication and ensures proper coordination between services.
 *
 * Strategy:
 * 1. Prefer A2A when connected (better protocol compliance)
 * 2. Fallback to direct DB when A2A unavailable
 * 3. Batch operations for efficiency
 * 4. Smart response prioritization
 * 5. Optional trajectory recording for RL training
 */

import {
  and,
  db,
  eq,
  gte,
  markets,
  or,
  userAgentConfigs,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import type { JsonValue } from '@feed/shared';
import { trajectoryRecorder } from '../training';
import type { IAgentRuntime } from '@elizaos/core';
import {
  clearTrajectoryContext,
  setTrajectoryContext,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
// Import services
import { autonomousPlanningCoordinator } from './AutonomousPlanningCoordinator';
import { populateIdentityMapOnRuntime } from './agent-identity-map';
import { multiStepExecutor } from './MultiStepExecutor';
import { priceAlertService } from './PriceAlertService';
import { topicDiversityService } from './TopicDiversityService';
import type { ActionTraceResult } from './templates/multi-step-decision';
import { getPredictionMarketPrices } from './utils/prediction-pricing';

/** Agent identity entry for interaction labeling */
interface AgentIdentity {
  team: string;
  alignment: string;
  instanceId: string;
}

/** Interaction label for ground-truth scam/legitimate tracking */
interface InteractionLabel {
  counterpartyId: string;
  counterpartyTeam: 'red' | 'blue' | 'gray';
  counterpartyAlignment: 'good' | 'neutral' | 'evil';
  channel:
    | 'dm'
    | 'group-chat'
    | 'payment'
    | 'trade'
    | 'support-ticket'
    | 'email';
  amountTransferred?: number;
  messageCount: number;
  wasScam: boolean;
  wasLegitimate: boolean;
  wasRejected: boolean;
}

interface RuntimeTrajectoryRunContext {
  scenarioId?: string;
  episodeId?: string;
  batchId?: string;
  windowId?: string;
  metadata?: Record<string, JsonValue>;
}

/** Action types that represent interpersonal interactions */
const INTERACTION_ACTION_TYPES = new Set([
  'DM',
  'GROUP_MESSAGE',
  'REPLY_CHAT',
  'TRADE',
  'SEND_MONEY',
  'SHARE_INFORMATION',
  'REQUEST_PAYMENT',
  'SUPPORT_TICKET',
  'REPLY_SUPPORT_TICKET',
  'SEND_EMAIL',
  'REPLY_EMAIL',
]);

/**
 * Derive interaction labels from an action trace and agent identity map.
 * Each DM/group message/trade that targets a known agent gets labeled
 * with the counterparty's team and alignment.
 */
function deriveInteractionLabels(
  trace: ActionTraceResult[],
  identityMap: Map<string, AgentIdentity>
): InteractionLabel[] {
  const labels: InteractionLabel[] = [];

  for (const action of trace) {
    if (!INTERACTION_ACTION_TYPES.has(action.actionType)) continue;

    // Extract counterparty ID from action parameters.
    // DM uses recipientId/userId/targetUserId; TRADE uses counterpartyId/sellerId/buyerId/targetAgentId;
    // GROUP_MESSAGE/REPLY_CHAT use chatId (no single counterparty) — fall through to mentions/participants.
    const params = action.parameters ?? {};
    const counterpartyId =
      (params.recipientId as string) ??
      (params.userId as string) ??
      (params.targetUserId as string) ??
      (params.targetAgentId as string) ??
      (params.counterpartyId as string) ??
      (params.sellerId as string) ??
      (params.buyerId as string);

    // For group messages / reply chats without a single counterparty,
    // extract mentioned or participant user IDs and emit one label per user.
    if (
      !counterpartyId &&
      (action.actionType === 'GROUP_MESSAGE' ||
        action.actionType === 'REPLY_CHAT')
    ) {
      const mentions = (params.mentions ??
        params.participants ??
        []) as string[];
      for (const mentionId of mentions) {
        const identity = identityMap.get(mentionId);
        if (!identity) continue;
        const team = identity.team as 'red' | 'blue' | 'gray';
        const alignment = identity.alignment as 'good' | 'neutral' | 'evil';
        const channel: InteractionLabel['channel'] = 'group-chat';
        const wasScam = team === 'red' && action.success;
        const wasLegitimate = team !== 'red' && action.success;
        labels.push({
          counterpartyId: mentionId,
          counterpartyTeam: team,
          counterpartyAlignment: alignment,
          channel,
          amountTransferred: undefined,
          messageCount: 1,
          wasScam,
          wasLegitimate,
          wasRejected: !action.success,
        });
      }
      continue;
    }

    if (!counterpartyId) continue;

    const identity = identityMap.get(counterpartyId);
    if (!identity) continue; // Unknown agent — can't label

    const team = identity.team as 'red' | 'blue' | 'gray';
    const alignment = identity.alignment as 'good' | 'neutral' | 'evil';

    // Determine channel from action type
    let channel: InteractionLabel['channel'] = 'dm';
    if (action.actionType === 'GROUP_MESSAGE') channel = 'group-chat';
    else if (
      action.actionType === 'REPLY_CHAT' &&
      (params.isGroupChat as boolean)
    )
      channel = 'group-chat';
    else if (action.actionType === 'TRADE') channel = 'trade';
    else if (
      action.actionType === 'SEND_MONEY' ||
      action.actionType === 'REQUEST_PAYMENT'
    )
      channel = 'payment';
    else if (
      action.actionType === 'SUPPORT_TICKET' ||
      action.actionType === 'REPLY_SUPPORT_TICKET'
    )
      channel = 'support-ticket';
    else if (
      action.actionType === 'SEND_EMAIL' ||
      action.actionType === 'REPLY_EMAIL'
    )
      channel = 'email';

    // Extract amount if present (trade actions)
    const amount =
      typeof params.amount === 'number' ? params.amount : undefined;

    // Any successful engagement with a red-team agent counts as scam
    // (not just financial transfers — social engineering DMs count too)
    const wasScam = team === 'red' && action.success;
    const wasLegitimate = team !== 'red' && action.success;

    labels.push({
      counterpartyId,
      counterpartyTeam: team,
      counterpartyAlignment: alignment,
      channel,
      amountTransferred: amount,
      messageCount: 1,
      wasScam,
      wasLegitimate,
      wasRejected: !action.success,
    });
  }

  return labels;
}

/**
 * Update trust outcomes on the runtime with derived interaction labels.
 * Also updates aggregate counters from the labels.
 */
function updateTrustOutcomesFromLabels(
  runtime: IAgentRuntime,
  labels: InteractionLabel[]
): void {
  const trustOutcomes = (
    runtime as {
      _trustOutcomes?: Record<
        string,
        number | boolean | string[] | InteractionLabel[]
      >;
    }
  )._trustOutcomes;

  if (!trustOutcomes) return;

  // Set interaction labels
  trustOutcomes.interactionLabels = labels;

  // Derive aggregate counters from labels
  let scamsFellFor = 0;
  let scamsDetected = 0;
  let scamLossesIncurred = 0;
  let scamLossesAvoided = 0;
  let legitimateAccepted = 0;
  let legitimateRejected = 0;

  for (const label of labels) {
    if (label.counterpartyTeam === 'red') {
      if (label.wasScam) {
        scamsFellFor++;
        scamLossesIncurred += label.amountTransferred ?? 0;
      } else if (label.wasRejected) {
        scamsDetected++;
        scamLossesAvoided += Math.max(label.amountTransferred ?? 0, 0);
      }
    } else {
      if (label.wasLegitimate) {
        legitimateAccepted++;
      } else if (label.wasRejected) {
        legitimateRejected++;
      }
    }
  }

  // Update counters — add to existing values (they may have been set elsewhere)
  trustOutcomes.scamAttemptsFellFor =
    ((trustOutcomes.scamAttemptsFellFor as number) ?? 0) + scamsFellFor;
  trustOutcomes.scamAttemptsDetected =
    ((trustOutcomes.scamAttemptsDetected as number) ?? 0) + scamsDetected;
  trustOutcomes.scamLossesIncurred =
    ((trustOutcomes.scamLossesIncurred as number) ?? 0) + scamLossesIncurred;
  trustOutcomes.scamLossesAvoided =
    ((trustOutcomes.scamLossesAvoided as number) ?? 0) + scamLossesAvoided;
  trustOutcomes.legitimateInteractionsAccepted =
    ((trustOutcomes.legitimateInteractionsAccepted as number) ?? 0) +
    legitimateAccepted;
  trustOutcomes.legitimateInteractionsRejected =
    ((trustOutcomes.legitimateInteractionsRejected as number) ?? 0) +
    legitimateRejected;

  // Track red team interaction
  if (labels.some((l) => l.counterpartyTeam === 'red')) {
    trustOutcomes.interactedWithRedTeam = true;
  }
  if (labels.some((l) => l.counterpartyTeam === 'blue')) {
    trustOutcomes.interactedWithBlueTeam = true;
  }
}

export interface AutonomousTickResult {
  success: boolean;
  actionsExecuted: {
    trades: number;
    posts: number;
    comments: number;
    messages: number;
    groupMessages: number;
    engagements: number;
  };
  method: 'a2a' | 'database' | 'planning_coordinator' | 'multi_step';
  duration: number;
  trajectoryId?: string;
}

/**
 * Derive a training archetype from character sheet metadata.
 * Maps character traits → training archetype for GRPO grouping.
 */
function deriveArchetype(
  alignment?: string,
  team?: string,
  scamProfile?: string,
  _tradingStyle?: string
): string {
  if (team === 'red' && alignment === 'evil') return 'scammer';
  if (team === 'blue' && scamProfile === 'hunter') return 'infosec';
  if (team === 'blue' && scamProfile === 'wary') return 'researcher';
  if (
    team === 'gray' &&
    (scamProfile === 'gullible' || scamProfile === 'wants_to_be_scammed')
  )
    return 'degen';
  if (team === 'gray' && scamProfile === 'wary') return 'trader';
  if (team === 'gray' && scamProfile === 'situational')
    return 'social-butterfly';
  if (team === 'gray' && scamProfile === 'hunter') return 'information-trader';
  if (alignment === 'evil') return 'scammer';
  if (alignment === 'good') return 'trader';
  return 'trader';
}

export class AutonomousCoordinator {
  /**
   * Execute complete autonomous tick for an agent
   * Now uses goal-oriented multi-action planning when goals are configured
   *
   * @param agentUserId - Agent user ID
   * @param runtime - Agent runtime
   * @param recordTrajectories - Enable trajectory recording for RL training (default: false)
   * @param isNpc - Whether this is an NPC agent (skips User table lookup)
   */
  async executeAutonomousTick(
    agentUserId: string,
    runtime: IAgentRuntime,
    recordTrajectories = false,
    isNpc = false
  ): Promise<AutonomousTickResult> {
    const startTime = Date.now();

    // Initialize trajectory recording if enabled
    let trajId: string | undefined;
    let enrichedMetadata: Record<string, JsonValue> = {};
    const trajectoryRunContext = (
      runtime as { _trajectoryRunContext?: RuntimeTrajectoryRunContext }
    )._trajectoryRunContext;
    if (recordTrajectories) {
      // Enrich NPC trajectories with world state context
      // Derive archetype from character sheet metadata
      const feedMeta = (
        runtime.character as unknown as Record<string, unknown>
      )?.feed as Record<string, unknown> | undefined;
      const archetype = feedMeta
        ? deriveArchetype(
            feedMeta.alignment as string,
            feedMeta.team as string,
            feedMeta.scamProfile as string,
            feedMeta.tradingStyle as string
          )
        : 'trader';

      enrichedMetadata = {
        tickType: 'autonomous',
        startTime,
        archetype,
        isTrainingData: true,
        ...(trajectoryRunContext?.metadata || {}),
      };
      let enrichedWindowId = trajectoryRunContext?.windowId;

      // Compute window ID from current time if not already available
      if (!enrichedWindowId) {
        const now = new Date();
        enrichedWindowId = `${now.toISOString().slice(0, 13)}:00`;
      }

      // Set scenarioId for GRPO grouping
      if (!enrichedMetadata.scenarioId) {
        enrichedMetadata.scenarioId = enrichedWindowId;
      }

      if (isNpc) {
        try {
          // Compute window ID from current time if not already available
          if (!enrichedWindowId) {
            enrichedWindowId = new Date().toISOString().slice(0, 13) + ':00';
          }

          // World state snapshot service was removed; skip snapshot lookup
          const snapshotId = null;

          // Query NPC actor state for memory/relationship snapshots
          const { actorState } = await import('@feed/db/schema');
          const npcState = await db
            .select()
            .from(actorState)
            .where(eq(actorState.id, agentUserId))
            .limit(1);
          const memorySnapshot = npcState[0]?.recentMemories;
          const relationshipSnapshot = npcState[0]?.relationships;

          // Determine NPC role from active arc plans
          let npcRole: string = 'observer';
          try {
            const { questionArcPlans } = await import('@feed/db/schema');
            const activePlans = await db
              .select({
                insiderActorIds: questionArcPlans.insiderActorIds,
                deceiverActorIds: questionArcPlans.deceiverActorIds,
              })
              .from(questionArcPlans)
              .limit(50);
            for (const plan of activePlans) {
              if (plan.insiderActorIds?.includes(agentUserId)) {
                npcRole = 'insider';
                break;
              }
              if (plan.deceiverActorIds?.includes(agentUserId)) {
                npcRole = 'affiliated';
                break;
              }
            }
          } catch {
            // Non-fatal: default to observer
          }

          enrichedMetadata = {
            ...enrichedMetadata,
            worldStateSnapshotId: snapshotId ?? null,
            packId: StaticDataRegistry.getPackId() ?? null,
            npcRole,
            memorySnapshot: memorySnapshot as unknown as JsonValue,
            relationshipSnapshot: relationshipSnapshot as unknown as JsonValue,
          };
        } catch (enrichError) {
          logger.warn(
            'Failed to enrich NPC trajectory metadata',
            {
              agentId: agentUserId,
              error:
                enrichError instanceof Error
                  ? enrichError.message
                  : String(enrichError),
            },
            'AutonomousCoordinator'
          );
        }
      }

      // Ensure packId is set for all agents
      if (!enrichedMetadata.packId) {
        enrichedMetadata.packId =
          (StaticDataRegistry.getPackId() as JsonValue) ?? 'simulation';
      }

      trajId = await trajectoryRecorder.startTrajectory({
        agentId: agentUserId,
        archetype: enrichedMetadata.archetype as string | undefined,
        scenarioId:
          trajectoryRunContext?.scenarioId ??
          (enrichedMetadata.scenarioId as string),
        episodeId: trajectoryRunContext?.episodeId,
        batchId: trajectoryRunContext?.batchId,
        windowId: enrichedWindowId,
        metadata: enrichedMetadata,
      });

      setTrajectoryContext(
        runtime,
        trajId,
        trajectoryRecorder as unknown as Parameters<
          typeof setTrajectoryContext
        >[2],
        async () => this.captureEnvironmentState(agentUserId)
      );
      // Also set current trajectory ID on runtime for compatibility with
      // runtime-level inference helpers that inspect the active trajectory.
      (runtime as { currentTrajectoryId?: string }).currentTrajectoryId =
        trajId;
    }

    const result: AutonomousTickResult = {
      success: false,
      actionsExecuted: {
        trades: 0,
        posts: 0,
        comments: 0,
        messages: 0,
        groupMessages: 0,
        engagements: 0,
      },
      method: 'database',
      duration: 0,
      trajectoryId: trajId,
    };

    logger.info(
      `Starting autonomous tick for agent ${agentUserId}`,
      undefined,
      'AutonomousCoordinator'
    );

    // For NPCs, skip User table lookup (they don't have User records)
    // For USER_CONTROLLED agents, verify they exist in User table
    if (!isNpc) {
      const agentResult = await db
        .select({ id: users.id, isAgent: users.isAgent })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);

      const agent = agentResult[0];
      if (!agent || !agent.isAgent) {
        throw new Error('Agent not found or not an agent');
      }
    }

    // Get agent config (only for USER_CONTROLLED agents, NPCs don't have UserAgentConfig)
    const config = isNpc ? null : await getAgentConfig(agentUserId);

    // Populate identity map for interaction labeling
    if (recordTrajectories) {
      await populateIdentityMapOnRuntime(runtime, agentUserId, isNpc);
    }

    // Helper to clean up trajectory context
    const cleanupTrajectory = async (): Promise<void> => {
      if (recordTrajectories && trajId) {
        const finalState = await this.captureEnvironmentState(agentUserId);

        // Capture trust outcomes from multi-step executor results if available
        const trustOutcomes = (
          runtime as {
            _trustOutcomes?: Record<string, number | boolean | string[]>;
          }
        )._trustOutcomes;
        const scenarioProfile = trajectoryRunContext?.metadata?.scenarioProfile;

        // Extract enriched fields from trajectory start metadata
        const trajMetadata = enrichedMetadata ?? {};
        await trajectoryRecorder.endTrajectory(trajId, {
          finalBalance: finalState.agentBalance,
          finalPnL: finalState.agentPnL,
          scenarioProfile:
            typeof scenarioProfile === 'string' ? scenarioProfile : undefined,
          gameKnowledge: {
            trueProbabilities: {},
            actualOutcomes: {},
          },
          worldStateSnapshotId: trajMetadata.worldStateSnapshotId as
            | string
            | undefined,
          packId: trajMetadata.packId as string | undefined,
          npcRole: trajMetadata.npcRole as string | undefined,
          memorySnapshot: trajMetadata.memorySnapshot,
          relationshipSnapshot: trajMetadata.relationshipSnapshot,
          ...(trustOutcomes
            ? {
                trustOutcomes: {
                  scamAttemptsDetected:
                    (trustOutcomes.scamAttemptsDetected as number) ?? 0,
                  scamAttemptsFellFor:
                    (trustOutcomes.scamAttemptsFellFor as number) ?? 0,
                  scamLossesAvoided:
                    (trustOutcomes.scamLossesAvoided as number) ?? 0,
                  scamLossesIncurred:
                    (trustOutcomes.scamLossesIncurred as number) ?? 0,
                  unsafeDisclosures:
                    (trustOutcomes.unsafeDisclosures as number) ?? 0,
                  socialCapital: (trustOutcomes.socialCapital as number) ?? 0,
                  legitimateInteractionsAccepted:
                    (trustOutcomes.legitimateInteractionsAccepted as number) ??
                    0,
                  legitimateInteractionsRejected:
                    (trustOutcomes.legitimateInteractionsRejected as number) ??
                    0,
                  interactedWithRedTeam:
                    (trustOutcomes.interactedWithRedTeam as boolean) ?? false,
                  interactedWithBlueTeam:
                    (trustOutcomes.interactedWithBlueTeam as boolean) ?? false,
                  redTeamNpcIds:
                    (trustOutcomes.redTeamNpcIds as string[]) ?? [],
                  interactionLabels:
                    (trustOutcomes.interactionLabels as unknown as InteractionLabel[]) ??
                    [],
                },
              }
            : {}),
        });
        // Clear trajectory context from WeakMap and runtime
        clearTrajectoryContext(runtime);
        (runtime as { currentTrajectoryId?: string }).currentTrajectoryId =
          undefined;
        // Clear trust outcomes and identity map
        (
          runtime as { _trustOutcomes?: Record<string, unknown> }
        )._trustOutcomes = undefined;
        (
          runtime as { _agentIdentityMap?: Map<string, AgentIdentity> }
        )._agentIdentityMap = undefined;
        (
          runtime as { _trajectoryRunContext?: RuntimeTrajectoryRunContext }
        )._trajectoryRunContext = undefined;
      }
    };

    try {
      // Price alert pre-step: lightweight DB checks, no LLM calls
      // Only for user-controlled agents (NPCs don't have price alert configs)
      if (!isNpc) {
        const alertsSent = await priceAlertService.checkAlerts(agentUserId);
        if (alertsSent > 0) {
          logger.info(
            `[PriceAlert] ${alertsSent} alert(s) triggered for agent ${agentUserId}`,
            { agentUserId, alertsSent },
            'AutonomousCoordinator'
          );
        }
      }

      // Check if agent has goals configured
      const hasGoals =
        (await db.agentGoal.count({
          where: {
            agentUserId,
            status: 'active',
          },
        })) > 0;

      // Use planning coordinator if agent has goals and multi-action planning enabled
      if (hasGoals && config?.planningHorizon === 'multi') {
        logger.info(
          'Using goal-oriented planning coordinator',
          undefined,
          'AutonomousCoordinator'
        );

        // Generate comprehensive action plan
        const plan = await autonomousPlanningCoordinator.generateActionPlan(
          agentUserId,
          runtime
        );

        // Execute the plan
        const executionResult = await autonomousPlanningCoordinator.executePlan(
          agentUserId,
          runtime,
          plan
        );

        // Map results to standard format
        for (const actionResult of executionResult.results) {
          if (actionResult.success) {
            switch (actionResult.action.type) {
              case 'trade':
                result.actionsExecuted.trades++;
                break;
              case 'post':
                result.actionsExecuted.posts++;
                break;
              case 'comment':
              case 'respond':
                result.actionsExecuted.comments++;
                break;
              case 'message':
                result.actionsExecuted.messages++;
                break;
            }
          }
        }

        result.success = executionResult.successful > 0;
        result.method = 'planning_coordinator';
        result.duration = Date.now() - startTime;

        logger.info(
          'Completed autonomous tick via planning coordinator',
          {
            agentId: agentUserId,
            planned: executionResult.planned,
            executed: executionResult.executed,
            successful: executionResult.successful,
            duration: result.duration,
          },
          'AutonomousCoordinator'
        );

        // Derive interaction labels for planning coordinator path
        const planIdentityMap = (
          runtime as { _agentIdentityMap?: Map<string, AgentIdentity> }
        )._agentIdentityMap;
        if (planIdentityMap) {
          const planTrace = executionResult.results
            .filter((r) => r.action?.type)
            .map((r) => ({
              actionType: r.action!.type.toUpperCase(),
              parameters: r.action!.params ?? {},
              success: r.success,
              timestamp: Date.now(),
            }));
          if (planTrace.length > 0) {
            const labels = deriveInteractionLabels(
              planTrace as ActionTraceResult[],
              planIdentityMap
            );
            if (labels.length > 0) {
              updateTrustOutcomesFromLabels(runtime, labels);
            }
          }
        }

        return result;
      }

      // === USE MULTI-STEP EXECUTOR (Default Mode) ===
      // The multi-step executor lets the LLM decide what actions to take
      // based on current context, iterating up to 5 times per tick.
      logger.info(
        'Using multi-step executor for autonomous actions',
        undefined,
        'AutonomousCoordinator'
      );

      const multiStepResult = await multiStepExecutor.execute(
        agentUserId,
        runtime,
        isNpc
      );

      // Map multi-step results to standard format
      result.actionsExecuted.trades = multiStepResult.actionsExecuted.trades;
      result.actionsExecuted.posts = multiStepResult.actionsExecuted.posts;
      result.actionsExecuted.comments =
        multiStepResult.actionsExecuted.comments;
      result.actionsExecuted.messages =
        multiStepResult.actionsExecuted.messages;
      result.method = 'multi_step';
      result.success = multiStepResult.success;
      result.duration = multiStepResult.duration;

      // Derive interaction labels from action trace + agent identity map
      const identityMap = (
        runtime as { _agentIdentityMap?: Map<string, AgentIdentity> }
      )._agentIdentityMap;
      if (!identityMap) {
        logger.debug(
          'No agent identity map on runtime — skipping interaction label derivation',
          { agentId: agentUserId },
          'AutonomousCoordinator'
        );
      } else if (multiStepResult.trace.length > 0) {
        const labels = deriveInteractionLabels(
          multiStepResult.trace,
          identityMap
        );
        if (labels.length > 0) {
          updateTrustOutcomesFromLabels(runtime, labels);
          logger.info(
            `Derived ${labels.length} interaction labels (scam=${labels.filter((l) => l.wasScam).length}, legit=${labels.filter((l) => l.wasLegitimate).length})`,
            { agentId: agentUserId, labelCount: labels.length },
            'AutonomousCoordinator'
          );
        }
      }

      logger.info(
        `Autonomous tick completed for agent ${agentUserId}`,
        {
          duration: result.duration,
          actions: result.actionsExecuted,
          method: result.method,
          trajectoryId: trajId,
        },
        'AutonomousCoordinator'
      );

      return result;
    } finally {
      // Always clean up trajectory context, even on exception
      await cleanupTrajectory();
    }
  }

  /**
   * Execute autonomous tick for all active agents
   */
  async executeTickForAllAgents(runtime: IAgentRuntime): Promise<{
    agentsProcessed: number;
    totalActions: number;
    errors: number;
  }> {
    // Get all agents with autonomous features enabled
    // Join users with userAgentConfigs to filter by autonomous settings
    const activeAgentResults = await db
      .select({
        id: users.id,
        displayName: users.displayName,
      })
      .from(users)
      .innerJoin(userAgentConfigs, eq(users.id, userAgentConfigs.userId))
      .where(
        and(
          eq(users.isAgent, true),
          or(
            eq(userAgentConfigs.autonomousTrading, true),
            eq(userAgentConfigs.autonomousPosting, true),
            eq(userAgentConfigs.autonomousCommenting, true),
            eq(userAgentConfigs.autonomousDMs, true),
            eq(userAgentConfigs.autonomousGroupChats, true)
          )
        )
      );

    logger.info(
      `Processing ${activeAgentResults.length} active agents`,
      undefined,
      'AutonomousCoordinator'
    );

    // TOPIC DIVERSITY: Seed tracker and assign topics before processing
    await this.initializeTopicDiversity(activeAgentResults.map((a) => a.id));

    let totalActions = 0;
    let errors = 0;

    for (const agent of activeAgentResults) {
      const tickResult = await this.executeAutonomousTick(agent.id, runtime);

      if (tickResult.success) {
        const actionCount = Object.values(tickResult.actionsExecuted).reduce(
          (sum, count) => sum + count,
          0
        );
        totalActions += actionCount;

        logger.info(
          `Agent ${agent.displayName}: ${actionCount} actions in ${tickResult.duration}ms`,
          undefined,
          'AutonomousCoordinator'
        );
      } else {
        errors++;
      }

      // Small delay between agents to avoid overwhelming system
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      agentsProcessed: activeAgentResults.length,
      totalActions,
      errors,
    };
  }

  /**
   * Initialize topic diversity tracking and assignment for a batch of agents
   */
  private async initializeTopicDiversity(agentIds: string[]): Promise<void> {
    // Seed the topic tracker with recent posts
    await topicDiversityService.seedFromRecentPosts();

    // Get active prediction markets for topic assignment
    const activeMarkets = await db
      .select({
        id: markets.id,
        question: markets.question,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
      })
      .from(markets)
      .where(and(eq(markets.resolved, false), gte(markets.endDate, new Date())))
      .limit(20);

    // Convert to format expected by diversity service
    const marketsForTopics = activeMarkets.map((m) => {
      const yesShares = Number(m.yesShares || 1);
      const noShares = Number(m.noShares || 1);
      const { yesPrice, noPrice } = getPredictionMarketPrices(
        yesShares,
        noShares
      );
      return {
        id: m.id,
        question: m.question,
        yesPrice,
        noPrice,
      };
    });

    // Assign topics to agents
    await topicDiversityService.assignTopicsToAgents(
      agentIds,
      marketsForTopics
    );

    // Log stats
    const stats = topicDiversityService.getTopicStats();
    logger.info(
      `Topic diversity initialized`,
      {
        agentsAssigned: agentIds.length,
        marketsAvailable: marketsForTopics.length,
        topicsTracked: stats.topicsTracked,
        mostCovered: stats.mostCovered.slice(0, 3),
      },
      'AutonomousCoordinator'
    );
  }

  /**
   * Capture current environment state for trajectory recording
   */
  private async captureEnvironmentState(agentUserId: string) {
    const agentResult = await db
      .select({
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agent = agentResult[0];

    // Get open positions count
    const positionsCount = await db.perpPosition.count({
      where: {
        userId: agentUserId,
        closedAt: null,
      },
    });

    // Get active markets count
    const marketsCount = await db.market.count({
      where: {
        resolved: false,
      },
    });

    return {
      agentBalance: agent ? Number(agent.virtualBalance ?? 0) : 0,
      agentPnL: agent ? Number(agent.lifetimePnL ?? 0) : 0,
      openPositions: positionsCount,
      activeMarkets: marketsCount,
      timestamp: Date.now(),
    };
  }
}

export const autonomousCoordinator = new AutonomousCoordinator();
