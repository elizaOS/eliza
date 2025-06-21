import {
  type IAgentRuntime,
  type UUID,
  type Memory,
  type Content,
  // type Character, // Available if needed
  EventType,
  createUniqueUuid,
  asUUID,
  ChannelType,
  // Role, // Available if needed
  logger,
} from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import type {
  Scenario,
  ScenarioResult,
  ScenarioContext,
  ScenarioActor,
  ScenarioMessage,
  ScenarioRunOptions,
  ScenarioProgressCallback,
  ScriptStep,
} from './types.js';
import { ScenarioVerifier } from './verification.js';
import { MetricsCollector } from './metrics.js';
import { ProductionVerificationSystem } from './integration-test.js';
import { ScenarioActionTracker } from '../commands/scenario/action-tracker.js';
import { v4 as uuidv4 } from 'uuid';
// import { getMessageManager } from '../utils/runtime-context'; // Module not found
// import { calculateFactorQuality } from '../verification/evaluator'; // Module not found
// import { ScenarioService } from '../services/scenario'; // Module not found
// import { validateSendScenarioEvent } from './types'; // Not exported
// import type { LoadedScenario, Message, VerificationRule } from './types'; // Not exported
// import { ActionTracker } from '../commands/scenario/action-tracker'; // Not exported

export class ScenarioRunner {
  private primaryRuntime: IAgentRuntime;
  private verifier: ScenarioVerifier;
  private metricsCollector: MetricsCollector;
  private productionVerificationSystem: ProductionVerificationSystem;
  private activeScenarios = new Map<string, ScenarioContext>();

  // Add these interfaces
  private scenario: any;
  private runtime: IAgentRuntime;

  // Add property to store agents map
  public agents: Map<string, IAgentRuntime> = new Map();

  constructor(_server: AgentServer, primaryRuntime: IAgentRuntime) {
    this.primaryRuntime = primaryRuntime;
    this.verifier = new ScenarioVerifier(primaryRuntime);
    this.metricsCollector = new MetricsCollector();
    this.productionVerificationSystem = new ProductionVerificationSystem(this.primaryRuntime);
    this.runtime = primaryRuntime;
  }

  async runScenario(
    scenario: Scenario,
    _options: ScenarioRunOptions = {},
    progressCallback?: ScenarioProgressCallback
  ): Promise<ScenarioResult> {
    // Validate scenario
    this.validateScenario(scenario);

    const startTime = Date.now();
    let context: ScenarioContext | null = null;

    try {
      // Setup phase
      progressCallback?.({
        scenarioId: scenario.id,
        phase: 'setup',
        step: 1,
        totalSteps: 4,
        message: 'Setting up scenario environment',
      });

      try {
        context = await this.setupScenario(scenario);
      } catch (setupError) {
        logger.error('Error in setupScenario:', setupError);
        logger.error(
          'Error details:',
          setupError instanceof Error ? setupError.message : String(setupError)
        );
        logger.error(
          'Error stack:',
          setupError instanceof Error ? setupError.stack : 'No stack trace'
        );
        throw setupError;
      }
      this.activeScenarios.set(scenario.id, context);
      this.metricsCollector.start();

      // Execution phase
      progressCallback?.({
        scenarioId: scenario.id,
        phase: 'execution',
        step: 2,
        totalSteps: 4,
        message: 'Executing scenario',
      });

      await this.executeScenario(context, progressCallback);

      // Verification phase
      progressCallback?.({
        scenarioId: scenario.id,
        phase: 'verification',
        step: 3,
        totalSteps: 4,
        message: 'Verifying results',
      });

      // Use production verification system with all 5 improvements
      await this.productionVerificationSystem.initializeSystem();
      const verificationResults = await this.verifier.verify(scenario.verification.rules, context);

      // Metrics collection
      const metrics = this.metricsCollector.collect(context);
      context.metrics = metrics;

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Teardown phase
      progressCallback?.({
        scenarioId: scenario.id,
        phase: 'teardown',
        step: 4,
        totalSteps: 4,
        message: 'Cleaning up',
      });

      await this.teardownScenario(context);

      const result: ScenarioResult = {
        scenarioId: scenario.id,
        name: scenario.name,
        startTime,
        endTime,
        duration,
        passed: this.determinePass(verificationResults, scenario),
        score: this.calculateOverallScore(verificationResults),
        metrics: {
          duration,
          messageCount: context.transcript.length,
          stepCount: 0,
          tokenUsage: metrics.tokenUsage || { input: 0, output: 0, total: 0 },
          memoryUsage: metrics.memoryUsage || { peak: 0, average: 0, memoryOperations: 0 },
          actionCounts: metrics.actionCounts || {},
          responseLatency: metrics.responseLatency || { min: 0, max: 0, average: 0, p95: 0 },
          customMetrics: metrics.customMetrics,
        },
        verificationResults,
        transcript: context.transcript,
      };

      return result;
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      const errorResult: ScenarioResult = {
        scenarioId: scenario.id,
        name: scenario.name,
        startTime,
        endTime,
        duration,
        passed: false,
        metrics: {
          duration: endTime - startTime,
          messageCount: context?.transcript?.length || 0,
          stepCount: 0,
          tokenUsage: context?.metrics?.tokenUsage || { input: 0, output: 0, total: 0 },
          memoryUsage: context?.metrics?.memoryUsage || {
            peak: 0,
            average: 0,
            memoryOperations: 0,
          },
          actionCounts: context?.metrics?.actionCounts || {},
          responseLatency: context?.metrics?.responseLatency || {
            min: 0,
            max: 0,
            average: 0,
            p95: 0,
          },
          customMetrics: context?.metrics?.customMetrics,
        },
        verificationResults: [],
        transcript: context?.transcript || [],
        errors: [error instanceof Error ? error.message : String(error)],
      };

      if (context) {
        await this.teardownScenario(context);
      }

      return errorResult;
    } finally {
      if (scenario.id) {
        this.activeScenarios.delete(scenario.id);
      }
    }
  }

  async runScenarios(
    scenarios: Scenario[],
    options: ScenarioRunOptions = {}
  ): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];

    if (options.parallel && scenarios.length > 1) {
      const maxConcurrency = options.maxConcurrency || 3;
      const chunks = this.chunkArray(scenarios, maxConcurrency);

      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map((scenario) => this.runScenario(scenario, options))
        );
        results.push(...chunkResults);
      }
    } else {
      for (const scenario of scenarios) {
        const result = await this.runScenario(scenario, options);
        results.push(result);
      }
    }

    return results;
  }

  private async setupScenario(scenario: Scenario): Promise<ScenarioContext> {
    // Use the primary runtime that was passed to the constructor
    const primaryRuntime = this.primaryRuntime;
    if (!primaryRuntime) {
      throw new Error('No primary runtime available');
    }

    logger.info(`Setting up scenario with primary runtime: ${primaryRuntime.agentId}`);

    // Create isolated room and world for this scenario
    const worldId = asUUID(createUniqueUuid(primaryRuntime, `scenario-world-${scenario.id}`));
    const roomId = asUUID(createUniqueUuid(primaryRuntime, `scenario-room-${scenario.id}`));

    // Setup world
    try {
      await primaryRuntime.ensureWorldExists({
        id: worldId,
        name: `Scenario: ${scenario.name}`,
        agentId: primaryRuntime.agentId,
        serverId: `scenario-${scenario.id}`,
      });
    } catch (worldError) {
      logger.error('Error creating world:', worldError);
      throw worldError;
    }

    // Setup room
    const roomType = await this.mapRoomType(scenario.setup.roomType || 'group');
    await primaryRuntime.ensureRoomExists({
      id: roomId,
      name: scenario.setup.roomName || `${scenario.name} Room`,
      source: 'scenario-runner',
      type: roomType,
      channelId: `scenario-${scenario.id}`,
      serverId: `scenario-${scenario.id}`,
      worldId,
    });

    // Initialize actors - use the agents map that was passed in
    const actorMap = new Map<string, ScenarioActor>();
    for (const actor of scenario.actors) {
      // Find the runtime for this actor from the agents map
      const runtime = this.agents.get(actor.name);
      if (!runtime) {
        logger.warn(`No runtime found for actor ${actor.name}, using primary runtime`);
        actor.runtime = primaryRuntime as IAgentRuntime;
      } else {
        actor.runtime = runtime as IAgentRuntime;
        logger.info(`Assigned runtime ${runtime.agentId} to actor ${actor.name}`);

        // Ensure the agent joins the room
        try {
          await runtime.ensureRoomExists({
            id: roomId,
            name: scenario.setup.roomName || `${scenario.name} Room`,
            source: 'scenario-runner',
            type: roomType,
            channelId: `scenario-${scenario.id}`,
            serverId: `scenario-${scenario.id}`,
            worldId,
          });
          logger.info(`Agent ${actor.name} joined room ${roomId}`);
        } catch (error) {
          logger.warn(`Failed to add agent ${actor.name} to room:`, error);
        }
      }
      actorMap.set(actor.id, actor);
    }

    // Add initial context messages if specified
    if (scenario.setup.initialMessages) {
      for (const msg of scenario.setup.initialMessages) {
        await this.sendContextMessage(roomId, msg.content, msg.sender, primaryRuntime, worldId);
      }
    }

    const context: ScenarioContext = {
      scenario,
      actors: actorMap,
      roomId,
      worldId,
      startTime: Date.now(),
      transcript: [],
      metrics: {},
      state: {},
    };

    return context;
  }

  private async executeScenario(
    context: ScenarioContext,
    progressCallback?: ScenarioProgressCallback
  ): Promise<void> {
    const { scenario: _scenario, actors } = context;
    // const maxDuration = scenario.execution.maxDuration || 300000; // 5 minutes default
    // const maxSteps = scenario.execution.maxSteps || 100;

    // let stepCount = 0;
    // const startTime = Date.now();

    logger.info(`Executing scenario with ${actors.size} actors`);

    try {
      // Execute actor scripts sequentially
      for (const actor of actors.values()) {
        logger.info(`Checking actor ${actor.name} (${actor.id}) for script`);
        logger.info(`Actor has script: ${!!actor.script}, has runtime: ${!!actor.runtime}`);

        if (actor.script && actor.runtime) {
          logger.info(
            `Executing script for actor ${actor.name} with ${actor.script?.steps.length} steps`
          );
          await this.executeActorScript(actor, context, progressCallback);

          // Small delay between actors to allow for processing
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          logger.warn(`Skipping actor ${actor.name} - no script or runtime`);
        }
      }

      // Wait a bit for final responses
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error('Error during scenario execution:', error);
      throw error;
    }
  }

  private async executeActorScript(
    actor: ScenarioActor,
    context: ScenarioContext,
    _progressCallback?: ScenarioProgressCallback
  ): Promise<void> {
    if (!actor.script || !actor.runtime) return;

    for (let i = 0; i < actor.script?.steps.length; i++) {
      const step = actor.script?.steps[i];

      try {
        await this.executeScriptStep(actor, step, context);

        // Small delay between steps to allow for responses
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error(`Error executing step ${i} for actor ${actor.id}:`, error);
        break; // Stop this actor's script on error
      }
    }
  }

  private async executeScriptStep(
    actor: ScenarioActor,
    step: ScriptStep,
    context: ScenarioContext
  ): Promise<void> {
    switch (step.type) {
      case 'message':
        if (step.content && actor.runtime) {
          await this.sendActorMessage(actor, step.content, context);
        }
        break;

      case 'wait':
        if (step.waitTime) {
          await new Promise((resolve) => setTimeout(resolve, step.waitTime));
        }
        break;

      case 'react':
        // Reaction steps would be handled by message triggers
        break;

      case 'action':
        if (step.actionName && actor.runtime) {
          await this.executeActorAction(actor, step.actionName, step.actionParams || {}, context);
        }
        break;

      case 'assert':
        if (step.assertion) {
          this.validateAssertion(step.assertion, context);
        }
        break;
    }
  }

  private async sendActorMessage(
    actor: ScenarioActor,
    content: string,
    context: ScenarioContext
  ): Promise<void> {
    if (!actor.runtime) return;

    logger.info(`Sending message from actor ${actor.name}: "${content}"`);

    const message: Memory = {
      id: asUUID(uuidv4()),
      entityId: actor.runtime.agentId,
      agentId: actor.runtime.agentId,
      roomId: context.roomId,
      worldId: context.worldId,
      content: {
        text: content,
        source: 'scenario-runner',
      },
      createdAt: Date.now(),
    };

    // Record the outgoing message
    this.recordMessage(context, message);
    logger.info(
      `Recorded message in transcript, current transcript length: ${context.transcript.length}`
    );

    // Send through the message bus
    await actor.runtime.createMemory(message, 'messages');

    // For subject actors (the agent being tested), trigger message processing
    const subjectActor = context.scenario.actors.find((a) => a.role === 'subject');
    if (actor.role !== 'subject' && subjectActor && subjectActor.runtime) {
      logger.info(`Triggering message processing for subject actor ${subjectActor.name}`);

      // Create a promise to wait for the response
      const responsePromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Response timeout - no response received within 30 seconds');
          resolve();
        }, 30000); // 30 second timeout

        const callback = async (response: Content) => {
          clearTimeout(timeout);
          logger.info(`Received response from subject actor: ${JSON.stringify(response)}`);

          if (response) {
            // Create a memory for the response
            const responseMessage: Memory = {
              id: asUUID(uuidv4()),
              entityId: subjectActor.runtime!.agentId,
              agentId: subjectActor.runtime!.agentId,
              roomId: context.roomId,
              worldId: context.worldId,
              content: response,
              createdAt: Date.now(),
            };

            // Record the response
            this.recordMessage(context, responseMessage);

            // Record response latency
            this.metricsCollector.recordResponseLatency(Date.now() - message.createdAt!);
          }

          resolve();
        };

        try {
          // Create a message for the subject agent to process
          const messageForSubject: Memory = {
            id: asUUID(uuidv4()),
            entityId: actor.runtime!.agentId, // From the actor - we checked it's not null above
            agentId: subjectActor.runtime!.agentId, // To the subject - we checked it's not null above
            roomId: context.roomId,
            worldId: context.worldId,
            content: {
              text: content,
              source: 'scenario-runner',
            },
            createdAt: Date.now(),
          };

          // Store the message in the subject's memory
          subjectActor
            .runtime!.createMemory(messageForSubject, 'messages')
            .then(() => {
              // Trigger message processing through the runtime's event system
              subjectActor
                .runtime!.emitEvent(EventType.MESSAGE_RECEIVED, {
                  runtime: subjectActor.runtime!,
                  message: messageForSubject,
                  callback,
                })
                .then(() => {
                  logger.info('Message event emitted successfully');
                })
                .catch((error) => {
                  logger.error(`Error emitting message event:`, error);
                  clearTimeout(timeout);
                  resolve();
                });
            })
            .catch((error) => {
              logger.error(`Error creating memory for subject:`, error);
              clearTimeout(timeout);
              resolve();
            });
        } catch (error) {
          logger.error(`Error processing message for subject actor:`, error);
          clearTimeout(timeout);
          resolve();
        }
      });

      // Wait for the response
      await responsePromise;
      logger.info('Response handling complete');
    }
  }

  private async executeActorAction(
    actor: ScenarioActor,
    actionName: string,
    params: Record<string, any>,
    _context: ScenarioContext
  ): Promise<void> {
    this.metricsCollector.recordAction(actionName);

    // Action execution would depend on the specific action
    // This is a placeholder for action execution logic
    logger.debug(`Actor ${actor.id} executing action: ${actionName}`, params);
  }

  private validateAssertion(assertion: any, _context: ScenarioContext): void {
    // Assertion validation logic would go here
    logger.debug('Validating assertion:', assertion);
  }

  private recordMessage(context: ScenarioContext, message: Memory): void {
    const actor = Array.from(context.actors.values()).find(
      (a) => a.runtime?.agentId === message.entityId
    );

    const scenarioMessage: ScenarioMessage = {
      id: message.id || uuidv4(),
      timestamp: message.createdAt || Date.now(),
      actorId: message.entityId,
      actorName: actor?.name || 'Unknown',
      content: message.content,
      roomId: message.roomId,
      messageType:
        message.entityId ===
        context.scenario.actors.find((a) => a.role === 'subject')?.runtime?.agentId
          ? 'outgoing'
          : 'incoming',
    };

    context.transcript.push(scenarioMessage);
  }

  private async sendContextMessage(
    roomId: UUID,
    content: string,
    _sender: string,
    runtime: IAgentRuntime,
    worldId: UUID
  ): Promise<void> {
    const message: Memory = {
      id: asUUID(uuidv4()),
      entityId: asUUID(uuidv4()), // System message
      agentId: runtime.agentId,
      roomId,
      worldId,
      content: {
        text: content,
        source: 'scenario-setup',
      },
      createdAt: Date.now(),
    };

    await runtime.createMemory(message, 'messages');
  }

  private async mapRoomType(roomType: string): Promise<ChannelType> {
    // Use LLM to determine appropriate room type instead of hardcoded mapping
    const prompt = `Determine the most appropriate ElizaOS ChannelType for the room type: "${roomType}"

Available ChannelTypes:
- DM: Direct message between two users
- GROUP: Group conversation with multiple participants

Consider the context and provide the most suitable channel type. Respond with just "DM" or "GROUP".`;

    try {
      const { ModelType } = await import('@elizaos/core');
      const response = (await this.primaryRuntime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.1,
        maxTokens: 10,
      })) as string;

      const channelType = response.trim().toLowerCase();
      if (channelType.includes('dm')) {
        return ChannelType.DM;
      } else {
        return ChannelType.GROUP;
      }
    } catch (error) {
      logger.warn('Failed to determine room type via LLM, defaulting to GROUP:', error);
      return ChannelType.GROUP;
    }
  }

  private async teardownScenario(context: ScenarioContext): Promise<void> {
    // Since we're using the primary runtime for all actors, no need to stop individual runtimes
    // Just clean up any temporary resources if needed

    logger.debug(`Scenario ${context.scenario.id} teardown complete`);
  }

  private determinePass(verificationResults: any[], scenario: Scenario): boolean {
    if (verificationResults.length === 0) return false;

    const totalWeight = verificationResults.reduce((sum, result) => {
      const rule = scenario.verification.rules.find((r) => r.id === result.ruleId);
      return sum + (rule?.weight || 1);
    }, 0);

    const passedWeight = verificationResults.reduce((sum, result) => {
      if (result.passed) {
        const rule = scenario.verification.rules.find((r) => r.id === result.ruleId);
        return sum + (rule?.weight || 1);
      }
      return sum;
    }, 0);

    return passedWeight / totalWeight >= 0.7; // 70% threshold
  }

  private calculateOverallScore(verificationResults: any[]): number {
    if (verificationResults.length === 0) return 0;

    const totalScore = verificationResults.reduce((sum, result) => {
      return sum + (result.score || (result.passed ? 1 : 0));
    }, 0);

    return totalScore / verificationResults.length;
  }

  private validateScenario(scenario: Scenario): void {
    if (!scenario.id) {
      throw new Error('Scenario must have an ID');
    }
    if (!scenario.name) {
      throw new Error('Scenario must have a name');
    }
    if (!scenario.actors || scenario.actors.length === 0) {
      throw new Error('Scenario must have at least one actor');
    }

    // Validate that there's exactly one subject actor
    const subjectActors = scenario.actors.filter((a) => a.role === 'subject');
    if (subjectActors.length === 0) {
      throw new Error('Scenario must have exactly one subject actor');
    }
    if (subjectActors.length > 1) {
      throw new Error('Scenario can only have one subject actor');
    }

    // Validate verification rules
    if (scenario.verification?.rules && scenario.verification.rules.length === 0) {
      throw new Error('Scenario must have at least one verification rule');
    }

    for (const rule of scenario.verification.rules) {
      if (!rule.id) {
        throw new Error('All verification rules must have an ID');
      }
      if (!rule.type) {
        throw new Error('All verification rules must have a type');
      }
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Run comprehensive tests to validate all 5 technical improvements
   */
  async runProductionVerificationTests(): Promise<{
    allImprovementsWorking: boolean;
    overallScore: number;
    detailedResults: any;
  }> {
    logger.info('Running comprehensive production verification tests...');

    try {
      await this.productionVerificationSystem.initializeSystem();
      const results = await this.productionVerificationSystem.runComprehensiveTest();

      if (results.allImprovementsWorking) {
        logger.info('✅ All 5 technical improvements verified successfully');
      } else {
        logger.warn('⚠️ Some technical improvements need attention');
      }

      return {
        allImprovementsWorking: results.allImprovementsWorking,
        overallScore: results.overallScore,
        detailedResults: results,
      };
    } catch (error) {
      logger.error('Failed to run production verification tests:', error);
      return {
        allImprovementsWorking: false,
        overallScore: 0,
        detailedResults: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Run all scenario messages in sequence
   */
  async run(_options: RunOptions = {}): Promise<ExecutionResult> {
    if (!this.scenario) {
      throw new Error('No scenario loaded. Call loadScenario() first.');
    }

    console.log(`Starting scenario: ${this.scenario.name}`);

    // const _sleep = options.sleep || 1000;
    const results: ExecutionResult = {
      passed: 0,
      failed: 0,
      total: 0,
      messages: [],
    };

    // Initialize action tracker
    const _actionTracker = new ScenarioActionTracker(this.metricsCollector);

    // Attach action tracker to runtime
    if (this.runtime) {
      _actionTracker.attach(this.runtime);
    }

    // Run scenario logic here...

    // Get action execution stats
    const actionStats = _actionTracker.getStats();
    console.log('\n🔄 Action Execution Summary:');
    console.log(`  Total actions attempted: ${actionStats.total}`);
    console.log(`  Successful actions: ${actionStats.successful}`);
    console.log(`  Failed actions: ${actionStats.failed}`);

    if (actionStats.byAction.size > 0) {
      console.log('\n  Actions by type:');
      actionStats.byAction.forEach((count: number, action: string) => {
        console.log(`    ${action}: ${count}`);
      });
    }

    // Clean up
    _actionTracker.detach();

    return results;
  }
}

// Add missing type definitions
export interface RunOptions {
  sleep?: number;
}

export interface ExecutionResult {
  passed: number;
  failed: number;
  total: number;
  messages: any[];
}

export * from './types.js';
export * from './verification.js';
export * from './metrics.js';
