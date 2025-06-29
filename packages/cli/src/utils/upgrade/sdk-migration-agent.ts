import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import { logger } from '@elizaos/core';
import * as path from 'path';
import ora, { type Ora } from 'ora';

import { MigrationContext, MigrationResult, GateResult, GateConfig } from './types';
import { MigrationGuideLoader } from './migration-guide-loader';
import { getAllGates } from './gates';

export class SDKMigrationAgent extends EventEmitter {
  private context: MigrationContext;
  private gates: GateConfig[];
  private guideLoader: MigrationGuideLoader;
  private abortController: AbortController;
  private spinner: Ora;

  constructor(repoPath: string) {
    super();

    this.context = {
      repoPath: path.resolve(repoPath),
      currentGate: 0,
      messages: [],
      metadata: {
        hasActions: false,
        hasProviders: false,
        hasServices: false,
        hasEvaluators: false,
        filesAnalyzed: new Set(),
        filesModified: new Set(),
        filesCreated: new Set(),
        testsCreated: new Set(),
        buildPassing: false,
        typeCheckPassing: false,
      },
      guides: new Map(),
    };

    this.gates = getAllGates();
    this.guideLoader = new MigrationGuideLoader();
    this.abortController = new AbortController();
    this.spinner = ora();
  }

  async migrate(): Promise<MigrationResult> {
    const startTime = Date.now();
    const gateResults: GateResult[] = [];
    let totalCost = 0;

    try {
      // Load migration guides
      await this.guideLoader.loadAllGuides();

      // Initialize Claude Code session
      await this.initializeSession();

      // Execute each gate
      for (let i = 0; i < this.gates.length; i++) {
        const gate = this.gates[i];
        this.context.currentGate = i;

        this.emit('gateStart', i, gate.name);
        logger.info(`\nExecuting ${gate.name}`);
        this.spinner.start(gate.name);

        const gateResult = await this.executeGate(gate, i);
        gateResults.push(gateResult);

        if (!gateResult.passed) {
          this.spinner.fail(`${gate.name} failed`);
          throw new Error(`Migration failed at ${gate.name}: ${gateResult.error?.message}`);
        }

        this.spinner.succeed(gate.name);
        this.emit('gateComplete', i, true, gateResult);

        // Track cost
        const lastMessage = gateResult.messages[gateResult.messages.length - 1];
        if (lastMessage?.type === 'result' && 'total_cost_usd' in lastMessage) {
          totalCost += lastMessage.total_cost_usd;
        }
      }

      // Build summary
      const summary = {
        filesModified: this.context.metadata.filesModified.size,
        filesCreated: this.context.metadata.filesCreated.size,
        testsCreated: this.context.metadata.testsCreated.size,
        finalCoverage: this.context.metadata.currentCoverage || 0,
        totalTurns: this.context.messages.length,
        totalCost,
      };

      return {
        success: true,
        branchName: '1.x',
        repoPath: this.context.repoPath,
        duration: Date.now() - startTime,
        totalCost,
        gateResults,
        summary,
      };
    } catch (error) {
      logger.error('Migration failed:', error);
      this.abortController.abort();

      return {
        success: false,
        branchName: '1.x',
        repoPath: this.context.repoPath,
        duration: Date.now() - startTime,
        totalCost,
        gateResults,
        error: error as Error,
      };
    }
  }

  private async initializeSession(): Promise<void> {
    // Start a session to get session ID
    const initMessages: SDKMessage[] = [];

    for await (const message of query({
      prompt: "I'm ready to help you migrate an ElizaOS plugin from 0.x to 1.x. Let's begin!",
      abortController: this.abortController,
      options: {
        maxTurns: 1,
        cwd: this.context.repoPath,
        permissionMode: 'bypassPermissions',
        model: 'claude-4-opus-20250522',
      },
    })) {
      initMessages.push(message);

      if (message.type === 'system' && message.subtype === 'init') {
        this.context.sessionId = message.session_id;
        logger.debug(`Initialized session: ${message.session_id}`);
      }
    }
  }

  private async executeGate(gate: GateConfig, gateIndex: number): Promise<GateResult> {
    const startTime = Date.now();
    const strategy = gate.retryStrategy || { maxAttempts: 3, backoffMs: 2000 };
    let attempts = 0;
    let lastError: Error | undefined;
    const allMessages: SDKMessage[] = [];

    while (attempts < strategy.maxAttempts) {
      attempts++;

      try {
        // Build prompt with guides
        const prompt = gate.requiredGuides
          ? this.guideLoader.buildPromptWithGuides(gate.prompt, gate.requiredGuides)
          : gate.prompt;

        // Add retry context if not first attempt
        const finalPrompt =
          attempts > 1
            ? `${prompt}\n\nNote: This is attempt ${attempts}. The previous attempt failed validation. Please ensure you complete all required steps.`
            : prompt;

        // Execute with Claude Code SDK
        const gateMessages: SDKMessage[] = [];

        for await (const message of query({
          prompt: finalPrompt,
          abortController: this.abortController,
          options: {
            maxTurns: gate.maxTurns,
            appendSystemPrompt: gate.systemPrompt,
            cwd: this.context.repoPath,
            resume: this.context.sessionId,
            allowedTools: ['Read', 'Write', 'Bash', 'Search'],
            permissionMode: 'bypassPermissions',
            model: 'claude-4-opus-20250522',
          },
        })) {
          gateMessages.push(message);
          allMessages.push(message);
          this.context.messages.push(message);

          // Update session ID if needed
          if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
            this.context.sessionId = message.session_id;
          }

          // Call custom message handler
          if (gate.onMessage) {
            gate.onMessage(message, this.context);
          }

          // Emit progress
          this.emit('message', message, gateIndex);

          // Update spinner with activity
          if (message.type === 'assistant') {
            const text = this.extractTextFromMessage(message);
            const firstLine = text.split('\n')[0];
            if (firstLine && firstLine.length < 80) {
              this.spinner.text = `${gate.name}: ${firstLine}`;
            }
          }
        }

        // Validate gate completion
        const isValid = await gate.validation(this.context);

        if (isValid) {
          return {
            gateIndex,
            gateName: gate.name,
            passed: true,
            attempts,
            duration: Date.now() - startTime,
            messages: allMessages,
          };
        }

        // Validation failed
        lastError = new Error(`Gate validation failed after ${attempts} attempts`);

        if (attempts < strategy.maxAttempts) {
          logger.warn(`Gate ${gateIndex} validation failed, retrying...`);
          await this.wait(strategy.backoffMs * attempts);
        }
      } catch (error) {
        lastError = error as Error;
        logger.error(`Gate ${gateIndex} execution error:`, error);

        if (attempts < strategy.maxAttempts) {
          await this.wait(strategy.backoffMs * attempts);
        }
      }
    }

    // All attempts failed
    return {
      gateIndex,
      gateName: gate.name,
      passed: false,
      attempts,
      duration: Date.now() - startTime,
      messages: allMessages,
      error: lastError,
    };
  }

  private extractTextFromMessage(message: SDKMessage): string {
    if (message.type === 'assistant' && message.message.content) {
      return message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => ('text' in block ? block.text : ''))
        .join('');
    }
    return '';
  }

  private async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  printSummary(): void {
    console.log('\nMigration Summary:');
    console.log(`  Files Analyzed: ${this.context.metadata.filesAnalyzed.size}`);
    console.log(`  Files Modified: ${this.context.metadata.filesModified.size}`);
    console.log(`  Files Created: ${this.context.metadata.filesCreated.size}`);
    console.log(`  Tests Created: ${this.context.metadata.testsCreated.size}`);
    if (this.context.metadata.currentCoverage) {
      console.log(`  Test Coverage: ${this.context.metadata.currentCoverage}%`);
    }
  }

  printDebugInfo(): void {
    console.log('\nDebug Information:');
    console.log(`  Session ID: ${this.context.sessionId}`);
    console.log(`  Current Gate: ${this.context.currentGate}`);
    console.log(`  Total Messages: ${this.context.messages.length}`);
    console.log(`  Build Passing: ${this.context.metadata.buildPassing}`);
    console.log(`  TypeScript Passing: ${this.context.metadata.typeCheckPassing}`);
  }
}
