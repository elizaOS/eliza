/**
 * Agent Training Harness
 *
 * Runs agents in parallel with different archetypes, recording trajectories.
 */

import { HarnessA2AClient } from './a2a-client';
import { getArchetype } from './archetypes';
import type {
  A2AClientInterface,
  ActionResult,
  AgentContext,
  AgentDecision,
  HarnessConfig,
  HarnessResult,
  TrainableAgent,
  Trajectory,
  TrajectoryStep,
} from './types';

const ANVIL_PRIVATE_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];

interface AgentInstance {
  agent: TrainableAgent;
  archetypeId: string;
  instanceId: number;
  client: A2AClientInterface;
  trajectory: Trajectory;
}

export class AgentHarness {
  private config: HarnessConfig;
  private instances: AgentInstance[] = [];

  constructor(config: HarnessConfig) {
    this.config = {
      ...config,
      parallelAgents: Math.min(config.parallelAgents || 5, 10),
      tickInterval: config.tickInterval || 2000,
      ticksPerAgent: config.ticksPerAgent || 10,
      instancesPerAgent: config.instancesPerAgent || 1,
      recordTrajectories: config.recordTrajectories ?? true,
    };
  }

  /**
   * Initialize all agent instances
   */
  private async initializeInstances(): Promise<void> {
    let keyIndex = 0;
    let instanceId = 0;

    for (const agent of this.config.agents) {
      for (const archetype of this.config.archetypes) {
        for (let i = 0; i < this.config.instancesPerAgent; i++) {
          if (keyIndex >= ANVIL_PRIVATE_KEYS.length) {
            keyIndex = 0; // Wrap around if we run out of keys
          }

          // Build client: use clientFactory if provided, else default HarnessA2AClient
          let client: A2AClientInterface;
          if (this.config.clientFactory) {
            client = this.config.clientFactory(instanceId);
          } else {
            const harnessClient = new HarnessA2AClient({
              baseUrl: this.config.a2aUrl,
              privateKey: ANVIL_PRIVATE_KEYS[keyIndex],
            });
            // Register with A2A server (best-effort — already registered is fine)
            try {
              await harnessClient.register(
                `${agent.name}-${archetype.id}-${i}`,
                `${archetype.description} (${agent.language})`
              );
            } catch {
              // ignored
            }
            client = harnessClient;
          }

          // Initialize agent with archetype
          await agent.initialize({
            a2aUrl: this.config.a2aUrl,
            privateKey: ANVIL_PRIVATE_KEYS[keyIndex],
            archetype: archetype,
            name: `${agent.name}-${archetype.id}-${i}`,
            tickInterval: this.config.tickInterval,
          });

          // getAgentId() exists on HarnessA2AClient but not on all A2AClientInterface
          // implementations (e.g. BabylonProductionClient, SimulationA2AAdapter).
          const agentId =
            'getAgentId' in client &&
            typeof (client as { getAgentId(): string }).getAgentId ===
              'function'
              ? (client as { getAgentId(): string }).getAgentId()
              : `${agent.name}-${archetype.id}-${instanceId}`;

          const trajectory: Trajectory = {
            id: `traj-${Date.now()}-${instanceId}`,
            agentId,
            archetype: archetype.id,
            startTime: new Date().toISOString(),
            steps: [],
            totalReward: 0,
            metadata: {
              agentType: agent.id,
              language: agent.language,
              instanceId,
            },
          };

          this.instances.push({
            agent,
            archetypeId: archetype.id,
            instanceId,
            client,
            trajectory,
          });

          keyIndex++;
          instanceId++;
        }
      }
    }

    console.log(`Initialized ${this.instances.length} agent instances`);
  }

  /**
   * Execute a single tick for an instance, returning a step even on error.
   */
  private async executeTick(
    instance: AgentInstance,
    tick: number
  ): Promise<TrajectoryStep> {
    const { agent, client, trajectory } = instance;
    const archetype = getArchetype(instance.archetypeId);

    // Gather context
    const [portfolio, positionsData, marketsData, feedData] = await Promise.all(
      [
        client.getPortfolio(),
        client.getPositions(),
        client.getMarkets(),
        client.getFeed(10),
      ]
    );

    const context: AgentContext = {
      balance: portfolio.balance,
      positions: positionsData.positions,
      markets: marketsData.predictions,
      posts: feedData.posts,
      tick,
      archetype,
    };

    // Get agent decision
    const decision = await agent.decide(context);

    // Execute action
    let result: ActionResult;
    if (agent.execute) {
      result = await agent.execute(decision, client);
    } else {
      result = await this.executeAction(decision, client, context);
    }

    // Calculate reward
    const reward = this.calculateReward(decision, result, context, archetype);

    const step: TrajectoryStep = {
      tick,
      timestamp: new Date().toISOString(),
      context,
      decision,
      result,
      reward,
    };

    trajectory.steps.push(step);
    trajectory.totalReward += reward;

    return step;
  }

  /**
   * Default action executor
   */
  private async executeAction(
    decision: AgentDecision,
    client: HarnessA2AClient,
    context: AgentContext
  ): Promise<ActionResult> {
    switch (decision.action) {
      case 'BUY_YES':
      case 'BUY_NO': {
        if (context.markets.length === 0 || context.balance < 10) {
          return {
            success: false,
            action: decision.action,
            error: 'No markets or insufficient balance',
          };
        }
        const market =
          context.markets[Math.floor(Math.random() * context.markets.length)];
        const outcome = decision.action === 'BUY_YES' ? 'YES' : 'NO';
        const amount = Math.min(50, context.balance * 0.1);
        const trade = await client.buyShares(market.id, outcome, amount);
        return {
          success: true,
          action: decision.action,
          data: trade as unknown as Record<string, unknown>,
        };
      }

      case 'SELL_SHARES': {
        if (context.positions.length === 0) {
          return {
            success: false,
            action: decision.action,
            error: 'No positions to sell',
          };
        }
        const position = context.positions[0];
        const sharesToSell = position.shares * 0.5;
        const trade = await client.sellShares(
          position.marketId,
          position.outcome,
          sharesToSell
        );
        return {
          success: true,
          action: decision.action,
          data: trade as unknown as Record<string, unknown>,
        };
      }

      case 'CREATE_POST': {
        const content =
          (decision.params.content as string) ||
          'Automated post from training harness';
        const post = await client.createPost(content);
        return {
          success: true,
          action: decision.action,
          data: post as unknown as Record<string, unknown>,
        };
      }

      case 'LIKE_POST': {
        if (context.posts.length === 0) {
          return {
            success: false,
            action: decision.action,
            error: 'No posts to like',
          };
        }
        const post =
          context.posts[Math.floor(Math.random() * context.posts.length)];
        const result = await client.likePost(post.id);
        return {
          success: true,
          action: decision.action,
          data: result as unknown as Record<string, unknown>,
        };
      }

      case 'COMMENT_POST': {
        if (context.posts.length === 0) {
          return {
            success: false,
            action: decision.action,
            error: 'No posts to comment',
          };
        }
        const post =
          context.posts[Math.floor(Math.random() * context.posts.length)];
        const content =
          (decision.params.content as string) || 'Interesting point!';
        const result = await client.commentPost(post.id, content);
        return {
          success: true,
          action: decision.action,
          data: result as unknown as Record<string, unknown>,
        };
      }

      case 'VIEW_FEED':
      case 'DISCOVER_AGENTS':
      case 'SEARCH_USERS':
      case 'CHECK_LEADERBOARD':
      case 'CHECK_NOTIFICATIONS':
      case 'VIEW_MARKET_DATA':
      case 'HOLD':
        return { success: true, action: decision.action };

      default:
        return {
          success: false,
          action: decision.action,
          error: `Unknown action: ${decision.action}`,
        };
    }
  }

  /**
   * Calculate reward for a step
   */
  private calculateReward(
    decision: AgentDecision,
    result: ActionResult,
    context: AgentContext,
    archetype: {
      riskTolerance: number;
      actionWeights: { trade: number; post: number; social: number };
    }
  ): number {
    let reward = 0;

    // Base reward for successful action
    if (result.success) {
      reward += 1;

      // Bonus for archetype-aligned actions
      const actionType = decision.action;
      if (actionType.includes('BUY') || actionType === 'SELL_SHARES') {
        reward += archetype.actionWeights.trade * 2;
      }
      if (actionType === 'CREATE_POST') {
        reward += archetype.actionWeights.post * 2;
      }
      if (actionType.includes('LIKE') || actionType.includes('COMMENT')) {
        reward += archetype.actionWeights.social * 2;
      }
    } else {
      reward -= 0.5;
    }

    // Risk-adjusted reward
    if (decision.action.includes('BUY') && context.balance < 100) {
      // Penalize risky trading with low balance
      reward *= 1 - archetype.riskTolerance;
    }

    return reward;
  }

  /**
   * Run a batch of instances in parallel, capturing per-instance errors.
   */
  private async runBatch(
    batch: AgentInstance[],
    tick: number,
    errors: string[]
  ): Promise<TrajectoryStep[]> {
    const results = await Promise.allSettled(
      batch.map((instance) => this.executeTick(instance, tick))
    );

    return results.map((r, idx) => {
      if (r.status === 'fulfilled') return r.value;
      const msg =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      const label = `${batch[idx].agent.name}/${batch[idx].archetypeId} tick ${tick}`;
      errors.push(`${label}: ${msg}`);
      // Synthetic HOLD step — keeps trajectory length consistent with ticksPerAgent
      const syntheticStep: TrajectoryStep = {
        tick,
        timestamp: new Date().toISOString(),
        context: {
          balance: 0,
          positions: [],
          markets: [],
          posts: [],
          tick,
          archetype: batch[idx]
            ? getArchetype(batch[idx].archetypeId)
            : undefined,
        },
        decision: {
          action: 'HOLD' as const,
          params: {},
          reasoning: `Error: ${msg}`,
        },
        result: { success: false, action: 'HOLD' as const, error: msg },
        reward: -1,
      };
      // Push into trajectory so steps.length always equals ticksPerAgent
      batch[idx].trajectory.steps.push(syntheticStep);
      batch[idx].trajectory.totalReward -= 1;
      return syntheticStep;
    });
  }

  /**
   * Run the full training harness
   */
  async run(): Promise<HarnessResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    console.log('\n🎯 Agent Training Harness Starting...');
    console.log('=====================================');
    console.log(`Agents: ${this.config.agents.map((a) => a.name).join(', ')}`);
    console.log(
      `Archetypes: ${this.config.archetypes.map((a) => a.id).join(', ')}`
    );
    console.log(`Instances per combo: ${this.config.instancesPerAgent}`);
    console.log(`Ticks per agent: ${this.config.ticksPerAgent}`);
    console.log(`Parallel: ${this.config.parallelAgents}`);
    console.log('');

    // Initialize all instances
    await this.initializeInstances();

    // Run ticks
    for (let tick = 1; tick <= this.config.ticksPerAgent; tick++) {
      console.log(`\n📊 Tick ${tick}/${this.config.ticksPerAgent}`);

      // Process in batches
      for (
        let i = 0;
        i < this.instances.length;
        i += this.config.parallelAgents
      ) {
        const batch = this.instances.slice(i, i + this.config.parallelAgents);

        const steps = await this.runBatch(batch, tick, errors);

        // Log progress
        for (let j = 0; j < batch.length; j++) {
          const instance = batch[j];
          const step = steps[j];
          const symbol = step.result.success ? '✅' : '❌';
          console.log(
            `   ${symbol} ${instance.agent.name}/${instance.archetypeId}: ${step.decision.action}`
          );
        }
      }

      // Wait between ticks
      if (tick < this.config.ticksPerAgent) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.tickInterval)
        );
      }
    }

    // Finalize trajectories
    for (const instance of this.instances) {
      instance.trajectory.endTime = new Date().toISOString();

      // Cleanup agent
      if (instance.agent.cleanup) {
        try {
          await instance.agent.cleanup();
        } catch (err) {
          console.warn(
            `Cleanup failed for ${instance.agent.name}/${instance.archetypeId}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    const duration = Date.now() - startTime;
    const trajectories = this.instances.map((i) => i.trajectory);

    // Calculate stats
    const stats = this.calculateStats(trajectories);

    const result: HarnessResult = {
      agentsRun: this.instances.length,
      totalTicks: this.instances.length * this.config.ticksPerAgent,
      trajectories,
      duration,
      errors,
      stats,
    };

    // Save trajectories if enabled
    if (this.config.recordTrajectories && this.config.outputDir) {
      await this.saveTrajectories(trajectories);
    }

    console.log('\n=====================================');
    console.log('🏁 Training Complete!');
    console.log(`   Agents: ${result.agentsRun}`);
    console.log(`   Ticks: ${result.totalTicks}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`   Trajectories: ${trajectories.length}`);
    console.log(`   Errors: ${errors.length}`);
    console.log('');

    return result;
  }

  /**
   * Calculate statistics from trajectories
   */
  private calculateStats(trajectories: Trajectory[]) {
    const byArchetype: Record<
      string,
      { agents: number; ticks: number; avgReward: number }
    > = {};
    const byAgent: Record<
      string,
      { instances: number; ticks: number; avgReward: number }
    > = {};

    for (const traj of trajectories) {
      // By archetype
      if (traj.archetype) {
        if (!byArchetype[traj.archetype]) {
          byArchetype[traj.archetype] = { agents: 0, ticks: 0, avgReward: 0 };
        }
        byArchetype[traj.archetype].agents++;
        byArchetype[traj.archetype].ticks += traj.steps.length;
        byArchetype[traj.archetype].avgReward += traj.totalReward;
      }

      // By agent type
      const agentType = (traj.metadata?.agentType as string) || 'unknown';
      if (!byAgent[agentType]) {
        byAgent[agentType] = { instances: 0, ticks: 0, avgReward: 0 };
      }
      byAgent[agentType].instances++;
      byAgent[agentType].ticks += traj.steps.length;
      byAgent[agentType].avgReward += traj.totalReward;
    }

    // Calculate averages
    for (const stats of Object.values(byArchetype)) {
      if (stats.agents > 0) {
        stats.avgReward /= stats.agents;
      }
    }
    for (const stats of Object.values(byAgent)) {
      if (stats.instances > 0) {
        stats.avgReward /= stats.instances;
      }
    }

    return { byArchetype, byAgent };
  }

  /**
   * Save trajectories to files
   */
  private async saveTrajectories(trajectories: Trajectory[]): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');

    const outputDir = this.config.outputDir || './trajectories';

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save each trajectory
    for (const traj of trajectories) {
      const filename = `${traj.id}.json`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(traj, null, 2));
    }

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      trajectoryCount: trajectories.length,
      trajectories: trajectories.map((t) => ({
        id: t.id,
        archetype: t.archetype,
        agentType: t.metadata?.agentType,
        steps: t.steps.length,
        reward: t.totalReward,
      })),
    };
    fs.writeFileSync(
      path.join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2)
    );

    console.log(`📁 Saved ${trajectories.length} trajectories to ${outputDir}`);
  }
}

/**
 * Create and run a training harness
 */
export async function runHarness(
  config: HarnessConfig
): Promise<HarnessResult> {
  const harness = new AgentHarness(config);
  return harness.run();
}
