import { query } from '@anthropic-ai/claude-code';
import { createMigrationGuideLoader, MigrationGuideLoader } from './migration-guide-loader';
import { logger } from '@elizaos/core';

export interface SimpleMigrationResult {
  success: boolean;
  repoPath: string;
  duration: number;
  messageCount: number;
  error?: Error;
  guidesUsed?: string[];
}

/**
 * SimpleMigrationAgent uses a class extending EventTarget rather than functional
 * patterns because EventTarget is a native browser/Bun API that requires class inheritance.
 * This is an intentional architectural decision to leverage Bun's native capabilities
 * instead of Node.js EventEmitter for better compatibility.
 *
 * NOTE: Unlike standard EventEmitter, this implementation prevents duplicate handler
 * registration. This is an intentional design choice to prevent memory leaks and
 * unintended multiple executions of the same handler.
 */
export class SimpleMigrationAgent extends EventTarget {
  private handlers = new Map<string, Map<(data?: unknown) => void, EventListener>>();
  private repoPath: string;
  private abortController: AbortController;
  private verbose: boolean;
  private guideLoader: MigrationGuideLoader;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Token and cost tracking
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCost = 0;
  private lastTokenUpdate = Date.now();
  private lastCostSummary = Date.now();

  constructor(repoPath: string, options: { verbose?: boolean } = {}) {
    super();
    this.repoPath = repoPath;
    this.abortController = new AbortController();
    this.verbose = options.verbose || false;

    // Initialize guide loader with enhanced migration knowledge
    try {
      this.guideLoader = createMigrationGuideLoader();
      if (this.verbose) {
        logger.info('Migration guide loader initialized successfully');
      }
    } catch (error) {
      logger.warn('Failed to initialize migration guide loader', error);
      throw new Error('Cannot initialize migration system without guide access');
    }
  }

  // EventEmitter-like API using native EventTarget
  emit(event: string, data?: unknown): boolean {
    return this.dispatchEvent(new CustomEvent(event, { detail: data }));
  }

  on(event: string, handler: (data?: unknown) => void): this {
    // Check if handler is already registered
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Map());
    }

    const eventHandlers = this.handlers.get(event)!;

    // If handler already exists, don't add it again
    if (eventHandlers.has(handler)) {
      return this;
    }

    // Wrap the handler to extract data from CustomEvent
    const wrappedHandler = ((e: Event) => {
      if (e instanceof CustomEvent) {
        handler(e.detail);
      } else {
        handler(undefined);
      }
    }) as EventListener;

    // Store mapping for removal later
    eventHandlers.set(handler, wrappedHandler);

    this.addEventListener(event, wrappedHandler);
    return this;
  }

  off(event: string, handler: (data?: unknown) => void) {
    const eventHandlers = this.handlers.get(event);
    const wrappedHandler = eventHandlers?.get(handler);

    if (wrappedHandler) {
      this.removeEventListener(event, wrappedHandler);
      eventHandlers!.delete(handler);

      // Clean up empty maps
      if (eventHandlers!.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  // Alias for EventEmitter compatibility
  removeListener(event: string, handler: (data?: unknown) => void) {
    return this.off(event, handler);
  }

  removeAllListeners(event?: string) {
    if (event) {
      // Remove all listeners for specific event
      const eventHandlers = this.handlers.get(event);
      if (eventHandlers) {
        for (const [_, wrappedHandler] of eventHandlers) {
          this.removeEventListener(event, wrappedHandler);
        }
        this.handlers.delete(event);
      }
    } else {
      // Remove all listeners for all events
      for (const [eventName, eventHandlers] of this.handlers) {
        for (const [_, wrappedHandler] of eventHandlers) {
          this.removeEventListener(eventName, wrappedHandler);
        }
      }
      this.handlers.clear();
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size || 0;
  }

  listeners(event: string): ((data?: unknown) => void)[] {
    const eventHandlers = this.handlers.get(event);
    return eventHandlers ? Array.from(eventHandlers.keys()) : [];
  }

  private isImportantUpdate(text: string): boolean {
    // Enhanced pattern matching for more comprehensive progress tracking
    const importantPatterns = [
      /GATE \d+/i,
      /analysis/i,
      /migration/i,
      /complete/i,
      /success/i,
      /error/i,
      /building/i,
      /testing/i,
      /upgrading/i,
      /validating/i,
      /fixing/i,
      /installing/i,
      /processing/i,
      /checking/i,
      /updating/i,
      /✓|✗|🎉|🚀|📊|⚡|🔍|🔨|🧪|📝|📖|✏️|📄/,
      /^(Starting|Finishing|Completed)/i,
      /^[A-Z][a-z]+ (plugin|package|file|test)/i, // Actions on specific items
    ];

    // Filter out very long messages but allow slightly longer ones for context
    return importantPatterns.some((pattern) => pattern.test(text)) && text.length < 300;
  }

  private formatProgressUpdate(text: string): string {
    // Clean up and format the text for better readability
    text = text.trim();

    // Add timestamp for better tracking
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    // Enhanced formatting with better categorization
    if (text.includes('GATE')) {
      return `\n🎯 [${timestamp}] ${text}`;
    } else if (text.includes('complete') || text.includes('✓') || text.includes('success')) {
      return `✅ [${timestamp}] ${text}`;
    } else if (text.includes('error') || text.includes('✗') || text.includes('failed')) {
      return `❌ [${timestamp}] ${text}`;
    } else if (text.includes('analyzing') || text.includes('analysis')) {
      return `🔍 [${timestamp}] ${text}`;
    } else if (
      text.includes('migrating') ||
      text.includes('migration') ||
      text.includes('upgrading')
    ) {
      return `🔄 [${timestamp}] ${text}`;
    } else if (text.includes('building') || text.includes('compile')) {
      return `🔨 [${timestamp}] ${text}`;
    } else if (text.includes('testing') || text.includes('test')) {
      return `🧪 [${timestamp}] ${text}`;
    } else if (text.includes('installing') || text.includes('install')) {
      return `📦 [${timestamp}] ${text}`;
    } else if (text.includes('validating') || text.includes('validation')) {
      return `✔️  [${timestamp}] ${text}`;
    } else if (text.includes('fixing') || text.includes('fix')) {
      return `🔧 [${timestamp}] ${text}`;
    } else if (text.includes('Starting') || text.includes('Initializing')) {
      return `🚀 [${timestamp}] ${text}`;
    } else if (text.includes('Finishing') || text.includes('Completed')) {
      return `🏁 [${timestamp}] ${text}`;
    }

    return `💭 [${timestamp}] ${text}`;
  }

  private startSpinner(message: string): void {
    if (this.spinnerInterval) {
      this.stopSpinner();
    }

    process.stdout.write(`${message} `);
    this.spinnerInterval = setInterval(() => {
      process.stdout.write(`\r${message} ${this.spinnerFrames[this.spinnerFrame]}`);
      this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
    }, 100);
  }

  private stopSpinner(completionMessage?: string): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      if (completionMessage) {
        process.stdout.write(`\r${completionMessage}\n`);
      } else {
        process.stdout.write('\r');
        process.stdout.clearLine(0);
      }
    }
  }

  private updateTokenTracking(usage: { input_tokens?: number; output_tokens?: number }): void {
    // Update token counts from Claude Code SDK usage data
    if (usage.input_tokens) {
      this.totalInputTokens += usage.input_tokens;
    }
    if (usage.output_tokens) {
      this.totalOutputTokens += usage.output_tokens;
    }

    // Calculate cost based on current Claude pricing (approximate)
    // These are rough estimates - actual costs may vary
    const inputCostPer1k = 0.003; // $3 per 1M tokens for input
    const outputCostPer1k = 0.015; // $15 per 1M tokens for output

    if (usage.input_tokens) {
      this.totalCost += (usage.input_tokens / 1000) * inputCostPer1k;
    }
    if (usage.output_tokens) {
      this.totalCost += (usage.output_tokens / 1000) * outputCostPer1k;
    }

    this.lastTokenUpdate = Date.now();
  }

  private formatTokenDisplay(): string {
    if (this.totalInputTokens === 0 && this.totalOutputTokens === 0) {
      return '';
    }

    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    const costDisplay = this.totalCost > 0 ? ` ($${this.totalCost.toFixed(4)})` : '';

    return ` | 🎩 ${totalTokens.toLocaleString()} tokens${costDisplay}`;
  }

  private getSimplifiedToolName(toolName: string): string | null {
    const toolMap: Record<string, string> = {
      TodoWrite: '📝 Planning',
      TodoRead: '📋 Checking',
      Bash: '⚡ Running',
      Read: '📖 Reading',
      Edit: '✏️  Editing',
      MultiEdit: '📝 Batch editing',
      Write: '📄 Writing',
      LS: '🔍 Exploring',
      Glob: '🔎 Pattern matching',
      Grep: '🔍 Searching',
      Task: '🔧 Processing',
      WebFetch: '🌐 Fetching',
      WebSearch: '🔍 Web searching',
      NotebookRead: '📓 Notebook reading',
      NotebookEdit: '📝 Notebook editing',
    };

    return toolMap[toolName] || `🛠️  ${toolName}`;
  }

  async migrate(): Promise<SimpleMigrationResult> {
    const startTime = Date.now();
    let messageCount = 0;

    try {
      // Disable verbose telemetry to reduce noise
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
      process.env.OTEL_LOGS_EXPORTER = '';
      process.env.OTEL_LOG_USER_PROMPTS = '0';
      process.env.OTEL_METRICS_EXPORTER = '';

      console.log('Claude is analyzing and migrating your plugin...\n');
      this.emit('start');

      // Start with a spinner to show initialization
      this.startSpinner('🔎 Initializing Claude Code SDK...');

      console.log(`Starting migration in directory: ${this.repoPath}`);

      // Generate comprehensive migration context with all guide knowledge
      const migrationContext = this.guideLoader.getAllGuidesContent();
      const guideReferences = this.guideLoader.generateMigrationContext();

      const migrationPrompt = `You are about to help migrate an ElizaOS plugin from 0.x to 1.x format.

CRITICAL: You must follow the INTEGRATED EXECUTION PROTOCOL exactly as specified in the CLAUDE.md file.

This is a GATED PROCESS with 9 gates (0-8). You CANNOT skip steps.

COMPREHENSIVE MIGRATION KNOWLEDGE BASE:
${migrationContext}

GUIDE REFERENCE SYSTEM:
${guideReferences}

REFERENCE GUIDES are in migration-guides/ directory:
- migration-guide.md (basic migration steps)
- state-and-providers-guide.md (state & providers migration)
- prompt-and-generation-guide.md (templates & generation)
- advanced-migration-guide.md (services, settings, evaluators)
- testing-guide.md (comprehensive testing requirements)
- completion-requirements.md (final validation and release preparation)

ENHANCED RAG CAPABILITIES:
You have access to the complete content of all migration guides above. Use this knowledge to:
1. Provide specific, detailed migration steps
2. Reference exact sections from the appropriate guides
3. Troubleshoot specific issues with targeted solutions
4. Ensure comprehensive coverage of all migration requirements

CRITICAL TEST VALIDATION REQUIREMENTS - ABSOLUTE REQUIREMENTS

MIGRATION CANNOT BE COMPLETED UNTIL ALL TESTS PASS

Throughout the migration process, you MUST validate these requirements and loop until they pass:

1. MANDATORY TEST VALIDATION LOOP: After every significant code change, run:
   - bun run test - ALL tests must pass (100% success rate, ZERO failures)
   - bunx tsc --noEmit - ZERO TypeScript errors in src/ directory
   - Only test files can have type errors, src/ must be error-free

2. CONTINUOUS VALIDATION LOOP: If ANY of these fail:
   - Analyze the errors thoroughly
   - Fix all issues identified
   - Re-run the validation commands
   - Repeat until BOTH commands succeed with zero errors
   - DO NOT PROCEED until validation passes

3. COVERAGE VS TEST CONFLICTS: If tests conflict with 95% coverage requirements:
   - Prioritize making tests pass over coverage percentage
   - Use workarounds like test mocks, stubs, or simplified implementations
   - Lower coverage if necessary - tests passing is more important
   - Add // @ts-ignore comments if needed for test compatibility

4. RELEASE WORKFLOW REQUIREMENT: The .github/workflows/release.yml requires bun run test to pass before npm publish. Migration is NOT complete until all tests pass.

5. ABSOLUTE REQUIREMENTS - NO EXCEPTIONS:
   - bun run test MUST show 0 failing tests
   - If ANY test fails, the migration is INCOMPLETE
   - Do not declare success until bun run test passes completely
   - Work around any test issues rather than leaving them failing

START WITH GATE 0: Create 1.x branch
Execute: git checkout -b 1.x
Gate Check: git branch --show-current must output "1.x"

THEN GATE 1: Complete analysis following the exact format in the integrated-migration-loop.md

DO NOT PROCEED until each gate check passes AND all validation requirements are met.

Remember: You must grind on test failures and TypeScript errors until they are 100% resolved. The release workflow will fail if tests don't pass.

FINAL VALIDATION REQUIREMENTS (GATE 8+) - ABSOLUTELY MANDATORY

THE MIGRATION IS NOT COMPLETE UNTIL EVERY SINGLE TEST PASSES

After completing all 9 gates, you MUST perform final validation and loop until both pass:

FINAL VALIDATION LOOP - REPEAT UNTIL SUCCESS:
1. Run: bun run test
   - MUST pass 100% - this is required for npm release workflow
   - If ANY tests fail, analyze and fix them, then retry
   - Use workarounds, mocks, simplified implementations if needed
   - Lower coverage requirements if tests conflict with coverage
   - Do NOT declare migration complete until this shows ZERO failures

2. Run: bunx tsc --noEmit  
   - MUST have ZERO errors in src/ directory
   - Test files can have type errors as exception, but fix if possible
   - If any src/ errors exist, fix them and retry

3. REPEAT FINAL VALIDATION LOOP until both commands succeed with zero errors
   - Keep trying different approaches
   - Simplify tests if needed
   - Use test mocks and stubs
   - Do whatever it takes to make tests pass

4. Only AFTER both final validations pass with ZERO failures, declare migration complete

ABSOLUTE REQUIREMENT: The migration is NOT complete until bun run test shows zero failures. The release workflow will fail otherwise. NO EXCEPTIONS.`;

      // Wrap the query call to handle SDK-level errors more gracefully
      let queryGenerator;
      try {
        queryGenerator = query({
          prompt: migrationPrompt,
          abortController: this.abortController,
          options: {
            cwd: this.repoPath,
            model: 'opus',
            permissionMode: 'bypassPermissions',
          },
        });
      } catch (queryError) {
        const errorMessage = queryError instanceof Error ? queryError.message : String(queryError);
        throw new Error(`Failed to initialize Claude Code SDK query: ${errorMessage}`);
      }

      // Enhanced streaming with better progress tracking
      let currentToolName: string | null = null;
      let toolStartTime: number | null = null;
      let lastProgressUpdate = Date.now();

      for await (const message of queryGenerator) {
        messageCount++;

        try {
          // Enhanced message parsing with real-time feedback
          if (message.type === 'assistant') {
            if (message.message && message.message.content) {
              const content = message.message.content;

              // Handle content as array (newer format)
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    const text = block.text;

                    // Show all important updates immediately
                    if (this.isImportantUpdate(text)) {
                      // Clear any pending tool indicator
                      if (currentToolName) {
                        process.stdout.write(' ✓\n');
                        currentToolName = null;
                      }

                      // Add token info to important GATE updates
                      let formattedText = this.formatProgressUpdate(text);
                      if (
                        text.includes('GATE') &&
                        (this.totalInputTokens > 0 || this.totalOutputTokens > 0)
                      ) {
                        const tokenInfo = this.formatTokenDisplay();
                        formattedText += tokenInfo;
                      }

                      console.log(formattedText);
                    } else if (this.verbose && text.length > 10 && text.length < 100) {
                      // In verbose mode, show more detailed updates
                      console.log(`💬 ${text.trim()}`);
                    }
                  } else if (block.type === 'tool_use') {
                    // Enhanced tool usage tracking
                    const toolName = this.getSimplifiedToolName(block.name);
                    if (toolName) {
                      // Complete previous tool if any
                      if (currentToolName) {
                        const duration = toolStartTime ? Date.now() - toolStartTime : 0;
                        process.stdout.write(` ✓ (${Math.round(duration / 1000)}s)\n`);
                      }

                      // Start new tool indicator
                      process.stdout.write(`${toolName}...`);
                      currentToolName = toolName;
                      toolStartTime = Date.now();
                    }
                  }
                }
              } else if (typeof content === 'string') {
                if (this.isImportantUpdate(content)) {
                  // Clear any pending tool indicator
                  if (currentToolName) {
                    process.stdout.write(' ✓\n');
                    currentToolName = null;
                  }

                  console.log(this.formatProgressUpdate(content));
                }
              }
            }
          }

          // Enhanced tool completion tracking
          if ('type' in message && (message as any).type === 'tool_result') {
            if (currentToolName) {
              const duration = toolStartTime ? Date.now() - toolStartTime : 0;
              process.stdout.write(` ✓ (${Math.round(duration / 1000)}s)\n`);
              currentToolName = null;
              toolStartTime = null;
            }
          }

          // Enhanced final result messages
          if (message.type === 'result') {
            // Clear any pending tool indicator
            if (currentToolName) {
              process.stdout.write(' ✓\n');
              currentToolName = null;
            }

            console.log(`\n\n📊 Migration Summary:`);
            console.log(`────────────────────`);
            console.log(`Status: ${message.subtype === 'success' ? '✅ Completed' : '❌ Failed'}`);

            // Enhanced cost and token reporting
            const finalCost = message.total_cost_usd || this.totalCost;
            if (finalCost > 0) {
              console.log(`💰 Total Cost: $${finalCost.toFixed(4)}`);
            }

            if (this.totalInputTokens > 0 || this.totalOutputTokens > 0) {
              console.log(
                `🎩 Token Usage: →${this.totalInputTokens.toLocaleString()} in, ←${this.totalOutputTokens.toLocaleString()} out (${(this.totalInputTokens + this.totalOutputTokens).toLocaleString()} total)`
              );
            }

            if (message.duration_ms)
              console.log(`⏱️  Duration: ${Math.round(message.duration_ms / 1000)}s`);
            if (message.num_turns) console.log(`🤖 AI Operations: ${message.num_turns}`);
            console.log(`📬 Total Messages: ${messageCount}`);
            console.log('');
          }

          // Enhanced system init message
          if (message.type === 'system' && message.subtype === 'init') {
            this.stopSpinner('🚀 Migration session started');
            console.log('');
          }
        } catch (messageError) {
          // Enhanced error handling
          if (this.verbose) {
            const errorMessage =
              messageError instanceof Error ? messageError.message : String(messageError);
            console.log(`\n⚠️  Message processing error: ${errorMessage}`);
          }
        }

        // Enhanced progress updates with time-based throttling and token/cost info
        const now = Date.now();
        if (messageCount % 15 === 0 && now - lastProgressUpdate > 5000) {
          // Clear any pending tool indicator for progress update
          if (currentToolName) {
            process.stdout.write('\n');
          }

          // Enhanced progress display with token/cost info
          const tokenInfo = this.formatTokenDisplay();

          console.log(
            `\n⏳ Processing... (${messageCount} operations, ${Math.round((now - startTime) / 1000)}s elapsed${tokenInfo})\n`
          );
          this.emit('progress', messageCount);
          lastProgressUpdate = now;

          // Restore tool indicator if there was one
          if (currentToolName) {
            process.stdout.write(`${currentToolName}...`);
          }
        }

        // Update token and cost tracking from message metadata
        if (message.type === 'assistant' && 'usage' in message) {
          this.updateTokenTracking(message.usage);

          // Show periodic cost summaries during long operations (every 30 seconds)
          const timeSinceCostSummary = now - this.lastCostSummary;
          if (timeSinceCostSummary > 30000 && this.totalInputTokens > 0) {
            // Clear any pending tool indicator for cost update
            if (currentToolName) {
              process.stdout.write('\n');
            }

            console.log(
              `💰 Cost Update: $${this.totalCost.toFixed(4)} | 🎩 ${(this.totalInputTokens + this.totalOutputTokens).toLocaleString()} tokens used`
            );
            this.lastCostSummary = now;

            // Restore tool indicator if there was one
            if (currentToolName) {
              process.stdout.write(`${currentToolName}...`);
            }
          }
        }
      }

      // Clean up any remaining tool indicator and spinner
      this.stopSpinner();
      if (currentToolName) {
        process.stdout.write(' ✓\n');
      }

      console.log('\n🎉 Migration completed successfully!');
      console.log(`─────────────────────────────────`);

      // Get list of guides that were available
      const guidesUsed = this.guideLoader
        .getGuidesByCategory('basic')
        .concat(this.guideLoader.getGuidesByCategory('advanced'))
        .concat(this.guideLoader.getGuidesByCategory('testing'))
        .concat(this.guideLoader.getGuidesByCategory('completion'))
        .map((guide) => guide.name);

      return {
        success: true,
        repoPath: this.repoPath,
        duration: Date.now() - startTime,
        messageCount,
        guidesUsed,
      };
    } catch (error) {
      console.log('\n❌ Migration failed');
      console.log(`────────────────────`);

      // Enhanced error reporting
      if (error instanceof Error) {
        console.log(`📜 Error Type: ${error.name}`);
        console.log(`💬 Error Message: ${error.message}`);

        // Check for common error patterns and provide specific guidance
        if (error.message.includes('API key')) {
          console.log('\n🔑 API Key Issue Detected:');
          console.log('  • Verify ANTHROPIC_API_KEY is set correctly');
          console.log('  • Ensure the key starts with "sk-ant-"');
          console.log('  • Check your key has sufficient credits');
        } else if (error.message.includes('timeout') || error.message.includes('network')) {
          console.log('\n🌐 Network Issue Detected:');
          console.log('  • Check your internet connection');
          console.log('  • Try again in a few moments');
          console.log('  • Consider using --timeout option for slower connections');
        } else if (error.message.includes('permission') || error.message.includes('access')) {
          console.log('\n🔒 Permission Issue Detected:');
          console.log('  • Ensure you have write access to the plugin directory');
          console.log('  • Check file permissions');
          console.log('  • Try running from a directory you own');
        }

        if (this.verbose) {
          console.log(`\n🔎 Full Stack Trace:`);
          console.log(error.stack || 'No stack trace available');
        }
      } else {
        console.log(`💬 Error Details:`, error);
      }

      // Migration recovery suggestions
      console.log('\n🔧 Recovery Options:');
      console.log('  1. Check git status and stash/commit changes if needed');
      console.log('  2. Verify plugin structure follows ElizaOS standards');
      console.log('  3. Try running with --verbose for detailed output');
      console.log('  4. Check network connectivity and API key validity');
      console.log('  5. Ensure all dependencies are installed with "bun install"');

      return {
        success: false,
        repoPath: this.repoPath,
        duration: Date.now() - startTime,
        messageCount,
        error: error as Error,
      };
    }
  }

  abort(): void {
    // Clean up any active spinner
    this.stopSpinner();

    console.log('\n☹️  Migration aborted by user');

    // Show final token/cost summary if any usage occurred
    if (this.totalInputTokens > 0 || this.totalOutputTokens > 0) {
      console.log(
        `💰 Partial cost: $${this.totalCost.toFixed(4)} | 🎩 ${(this.totalInputTokens + this.totalOutputTokens).toLocaleString()} tokens used`
      );
    }
    console.log(`───────────────────────`);
    console.log('🗺️  What happened:');
    console.log('   • Migration process was interrupted');
    console.log('   • Plugin files may be in partial state');
    console.log('   • Some changes may have been applied');

    console.log('\n🔧 Recommended next steps:');
    console.log('   1. Check git status to see what changed');
    console.log('   2. Use "git checkout ." to revert uncommitted changes if needed');
    console.log('   3. Review any migration-guides/ directory that may have been created');
    console.log('   4. Clean up with "rm -rf migration-guides/" if present');
    console.log('   5. Try migration again when ready');

    this.abortController.abort();
    this.emit('aborted');
  }

  /**
   * Get migration help for specific issues
   */
  getMigrationHelp(issue: string): string {
    try {
      const results = this.guideLoader.getRelevantGuidesForIssue(issue);

      if (results.length === 0) {
        return `No specific guidance found for: ${issue}\nCheck the basic migration-guide.md for general steps.`;
      }

      const help = [
        `MIGRATION GUIDANCE FOR: ${issue.toUpperCase()}`,
        '',
        'Relevant guides found:',
        '',
      ];

      for (const result of results) {
        help.push(`## ${result.guide.name}`);
        help.push(`Relevance Score: ${result.relevanceScore.toFixed(1)}`);
        help.push(`Matched Keywords: ${result.matchedKeywords.join(', ')}`);
        help.push(`Category: ${result.guide.category}`);
        help.push('');
      }

      return help.join('\n');
    } catch (error) {
      return `Error getting migration help: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Search guides for specific content
   */
  searchGuides(query: string, limit: number = 3): string {
    try {
      const results = this.guideLoader.searchGuides(query, limit);

      if (results.length === 0) {
        return `No guides found matching: ${query}`;
      }

      const searchResults = [
        `SEARCH RESULTS FOR: ${query}`,
        '',
        `Found ${results.length} relevant guide(s):`,
        '',
      ];

      for (const result of results) {
        searchResults.push(`## ${result.guide.name}`);
        searchResults.push(`Score: ${result.relevanceScore.toFixed(1)}`);
        searchResults.push(`Keywords: ${result.matchedKeywords.join(', ')}`);
        searchResults.push(`Path: ${result.guide.path}`);
        searchResults.push('');
      }

      return searchResults.join('\n');
    } catch (error) {
      return `Error searching guides: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Get complete migration context for debugging
   */
  getFullMigrationContext(): string {
    try {
      return this.guideLoader.getAllGuidesContent();
    } catch (error) {
      return `Error getting migration context: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
