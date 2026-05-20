#!/usr/bin/env bun

/**
 * Coordinator Playground
 *
 * Interactive dev tool for testing coordinator LLM decisions without
 * running the full app. Uses the REAL prompt templates, action metadata,
 * coordinator context, and XML parser from the codebase — so changes
 * to the coordinator source are reflected here automatically.
 *
 * Usage:
 *   # Interactive mode — type messages, see decisions
 *   bun scripts/coordinator-playground.ts
 *
 *   # Single message
 *   bun scripts/coordinator-playground.ts "tell my agent to buy TSLAI"
 *
 *   # Batch mode — run test suite and generate a report
 *   bun scripts/coordinator-playground.ts --batch
 *
 *   # Batch with custom suite file
 *   bun scripts/coordinator-playground.ts --batch ./my-test-suite.json
 *
 *   # Options
 *   --agents 0|1|2       Number of agents in simulated team (default: 1)
 *   --temperature 0.4    Override temperature (default: 0.4)
 *   --model <id>         Override model (default: llama-3.3-70b-versatile)
 *   --iterations 5       Run each message N times (batch mode, for consistency)
 *   --verbose            Show full rendered prompt sent to LLM
 *   --json               Output results as JSON (batch mode)
 *   --history "msg1|msg2" Pipe-separated conversation history
 *   --dispatch-history "agent said X" Simulated dispatch history
 *
 * Requires: GROQ_API_KEY environment variable
 */

import { createGroq } from '@ai-sdk/groq';
import { userCorePlugin } from '@babylon/agents/plugins/plugin-user-core/src';
import { buildCoordinatorDecisionTemplate } from '@babylon/agents/plugins/plugin-user-core/src/coordinator-decision-template';
import { formatActionsWithParams } from '@babylon/agents/plugins/plugin-user-core/src/providers/actions';
import { COORDINATOR_CONTEXT_TEXT } from '@babylon/agents/plugins/plugin-user-core/src/providers/coordinator-context';
import { parseKeyValueXml } from '@elizaos/core';
import { generateText } from 'ai';

// =============================================================================
// Configuration
// =============================================================================

interface Config {
  agentCount: number;
  temperature: number;
  model: string;
  iterations: number;
  verbose: boolean;
  jsonOutput: boolean;
  conversationHistory: string[];
  dispatchHistory: string;
}

function parseArgs(): {
  mode: 'interactive' | 'single' | 'batch';
  message?: string;
  batchFile?: string;
  config: Config;
} {
  const args = process.argv.slice(2);
  const config: Config = {
    agentCount: 1,
    temperature: 0.4,
    model: 'llama-3.3-70b-versatile',
    iterations: 1,
    verbose: false,
    jsonOutput: false,
    conversationHistory: [],
    dispatchHistory: '',
  };

  let mode: 'interactive' | 'single' | 'batch' = 'interactive';
  let message: string | undefined;
  let batchFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--agents':
        config.agentCount = parseInt(args[++i] || '1', 10);
        break;
      case '--temperature':
        config.temperature = parseFloat(args[++i] || '0.4');
        break;
      case '--model':
        config.model = args[++i] || config.model;
        break;
      case '--iterations':
        config.iterations = parseInt(args[++i] || '1', 10);
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--json':
        config.jsonOutput = true;
        break;
      case '--history':
        config.conversationHistory = (args[++i] || '').split('|');
        break;
      case '--dispatch-history':
        config.dispatchHistory = args[++i] || '';
        break;
      case '--batch':
        mode = 'batch';
        if (args[i + 1] && !args[i + 1]!.startsWith('--')) {
          batchFile = args[++i];
        }
        break;
      default:
        if (!arg.startsWith('--')) {
          mode = 'single';
          message = arg;
        }
        break;
    }
  }

  return { mode, message, batchFile, config };
}

// =============================================================================
// Simulated State (only the parts that need DB in production)
// =============================================================================

const FAKE_AGENTS = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    name: 'TradingBot',
    username: 'trading_bot',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    name: 'ContentBot',
    username: 'content_bot',
  },
];

function buildTeamMembers(agentCount: number): string {
  if (agentCount === 0) {
    return `## Team Members

**Owner:** TestUser (@testuser)

**Agents:** No agents created yet. Suggest user create agents at /agents page.`;
  }

  const agents = FAKE_AGENTS.slice(0, agentCount);
  const agentLines = agents
    .map(
      (a) => `- ${a.name} (@${a.username}) [id: ${a.id}] - Available for tasks`
    )
    .join('\n');

  return `## Team Members

**Owner:** TestUser (@testuser)

**Agents (${agentCount}):**
${agentLines}`;
}

function buildRecentMessages(history: string[]): string {
  if (history.length === 0) {
    return `10:30 (5m ago) User: hey
10:31 (4m ago) You: Hey TestUser! How can I help you today? I can check markets, your portfolio, the feed, or coordinate your agents.`;
  }

  const now = new Date();
  return history
    .map((msg, i) => {
      const mins = (history.length - i) * 2;
      const time = new Date(now.getTime() - mins * 60000);
      const hh = String(time.getHours()).padStart(2, '0');
      const mm = String(time.getMinutes()).padStart(2, '0');
      const speaker = i % 2 === 0 ? 'User' : 'You';
      return `${hh}:${mm} (${mins}m ago) ${speaker}: ${msg}`;
    })
    .join('\n');
}

/**
 * Generate actionsWithParams from the REAL action objects in userCorePlugin.
 * Uses the same formatActionsWithParams function the coordinator uses.
 */
function buildActionsWithParams(): string {
  const actions = userCorePlugin.actions || [];
  if (actions.length === 0) return '';
  return `# Available Actions\n\n${formatActionsWithParams(actions as Parameters<typeof formatActionsWithParams>[0])}`;
}

// =============================================================================
// Prompt Builder — uses the REAL template from route.ts
// =============================================================================

/**
 * Renders the coordinator decision prompt by substituting Handlebars-style
 * template variables with simulated state. This mirrors exactly what
 * composePromptFromState() does in the real coordinator.
 */
function renderPrompt(message: string, config: Config): string {
  // Get the real template from route.ts
  const template = buildCoordinatorDecisionTemplate(config.agentCount);

  // Build all template variable values
  const values: Record<string, string | number | boolean> = {
    coordinatorContext: COORDINATOR_CONTEXT_TEXT,
    teamMembers: buildTeamMembers(config.agentCount),
    recentMessages: buildRecentMessages(config.conversationHistory),
    hasDispatchHistory: config.dispatchHistory.length > 0,
    dispatchHistory: config.dispatchHistory,
    currentMessage: message,
    ownerName: 'TestUser',
    iterationCount: 1,
    maxIterations: 5,
    actionCount: 0,
    actionsWithParams: buildActionsWithParams(),
    actionResults: 'No actions taken yet.',
    hasActionResults: false,
  };

  // Render Handlebars-style template variables
  let rendered = template;

  // Handle {{#if variable}}...{{else}}...{{/if}} blocks
  rendered = rendered.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, content: string) => {
      const [truthyContent, falsyContent = ''] = content.split('{{else}}');
      return values[varName] ? truthyContent : falsyContent;
    }
  );

  // Handle {{variable}} substitutions
  rendered = rendered.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return String(values[varName] ?? '');
  });

  return rendered;
}

// =============================================================================
// LLM Call
// =============================================================================

interface Decision {
  thought: string;
  action: string;
  parameters: Record<string, unknown>;
  isFinish: boolean;
  raw: string;
  latencyMs: number;
  parseError?: string;
}

async function callLLM(prompt: string, config: Config): Promise<Decision> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY not set. Export it or add to .env:\n  export GROQ_API_KEY=gsk_...'
    );
  }

  const groq = createGroq({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1',
  });

  const start = Date.now();

  const result = await generateText({
    model: groq.languageModel(config.model),
    prompt,
    temperature: config.temperature,
    maxOutputTokens: 512,
    maxRetries: 2,
    experimental_telemetry: { isEnabled: false },
  });

  const latencyMs = Date.now() - start;
  const raw = result.text;

  // Use the REAL parseKeyValueXml from ElizaOS (same parser the coordinator uses)
  const parsed = parseKeyValueXml(raw);

  if (!parsed) {
    return {
      thought: '',
      action: '',
      parameters: {},
      isFinish: false,
      raw,
      latencyMs,
      parseError:
        'Failed to parse XML response (parseKeyValueXml returned null)',
    };
  }

  return {
    thought: (parsed.thought as string) ?? '',
    action: ((parsed.action as string) ?? '').trim(),
    parameters: parseParameters(parsed.parameters),
    isFinish: parsed.isFinish === 'true' || parsed.isFinish === true,
    raw,
    latencyMs,
  };
}

function parseParameters(params: unknown): Record<string, unknown> {
  if (!params) return {};
  if (typeof params === 'object' && params !== null && !Array.isArray(params))
    return params as Record<string, unknown>;
  if (typeof params === 'string') {
    try {
      const parsed = JSON.parse(params);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }
  return {};
}

// =============================================================================
// Display
// =============================================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

function displayDecision(decision: Decision): void {
  if (decision.parseError) {
    console.log(
      `${C.bgRed}${C.white} PARSE ERROR ${C.reset} ${decision.parseError}`
    );
    console.log(`${C.dim}Raw:${C.reset} ${decision.raw.substring(0, 200)}`);
    return;
  }

  const action = decision.action || '(none)';
  let actionColor = C.dim;
  if (action.startsWith('DISPATCH')) actionColor = C.bgGreen + C.white;
  else if (action.startsWith('CHECK')) actionColor = C.cyan;
  else if (action === '(none)' || action === '') actionColor = C.yellow;

  console.log(
    `${actionColor} ${action} ${C.reset}  ${C.dim}${decision.latencyMs}ms${C.reset}`
  );
  console.log(`${C.dim}Thought:${C.reset} ${decision.thought}`);

  if (decision.action && Object.keys(decision.parameters).length > 0) {
    console.log(
      `${C.dim}Params:${C.reset}  ${JSON.stringify(decision.parameters)}`
    );
  }

  console.log(
    `${C.dim}Finish:${C.reset}  ${decision.isFinish ? C.green + 'yes' : C.yellow + 'no'}${C.reset}`
  );
}

// =============================================================================
// Test Suite (batch mode)
// =============================================================================

interface TestCase {
  message: string;
  /** Expected action (exact match). Use "" for no-action. undefined = any. */
  expectAction?: string;
  /** Description for the report */
  label?: string;
  /** Override agent count for this case */
  agents?: number;
}

interface TestResult {
  testCase: TestCase;
  decisions: Decision[];
  passed: boolean;
  failures: string[];
}

const DEFAULT_TEST_SUITE: TestCase[] = [
  // === DISPATCH (must dispatch) ===
  {
    label: 'Direct dispatch command',
    message: 'tell my agent to buy TSLAI for $100',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Indirect dispatch (have)',
    message: 'have my agent open a 2x long on NVDAI',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Indirect dispatch (get)',
    message: 'get the bot to post about the market',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Implicit dispatch (user wants trade)',
    message: 'buy TSLAI',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Implicit dispatch (user wants post)',
    message: 'post something funny about crypto',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Command verb dispatch',
    message: 'command the agent to close all positions',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Instruct verb dispatch',
    message: 'instruct trading_bot to sell everything',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Order verb dispatch',
    message: 'order the agent to open a short on AIPPL',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Polite dispatch request',
    message:
      'can you ask my agent to check what positions it has and close the losing ones?',
    expectAction: 'DISPATCH_TO_AGENT',
  },
  {
    label: 'Dispatch with context',
    message:
      'the market is dipping, tell my agent to open a long on TSLAI at 2x leverage for $50',
    expectAction: 'DISPATCH_TO_AGENT',
  },

  // === DATA QUERIES (must NOT dispatch) ===
  {
    label: 'Price check',
    message: 'what is the price of TSLAI?',
    expectAction: 'CHECK_PERPS',
  },
  {
    label: 'Portfolio check',
    message: "how's my portfolio doing?",
    expectAction: 'CHECK_USER_PNL',
  },
  {
    label: 'Feed check',
    message: "what's on the feed?",
    expectAction: 'CHECK_FEED_POSTS',
  },
  {
    label: 'Predictions check',
    message: 'show me prediction markets',
    expectAction: 'CHECK_PREDICTIONS',
  },
  {
    label: 'Recent trades check',
    message: 'what are the recent market trades?',
    expectAction: 'CHECK_RECENT_MARKET_TRADES',
  },
  {
    label: 'All markets overview',
    message: 'show me all the markets',
    expectAction: 'CHECK_PERPS',
  },

  // === CONVERSATIONAL (no action) ===
  {
    label: 'General question',
    message: 'what is Babylon?',
    expectAction: '',
  },
  {
    label: 'Thanks response',
    message: 'thanks!',
    expectAction: '',
  },
  {
    label: 'How does trading work',
    message: 'how do perpetuals work here?',
    // LLM may reasonably fetch CHECK_PERPS to illustrate, or answer directly
    expectAction: undefined,
  },

  // === NO AGENTS (should not dispatch) ===
  {
    label: 'Dispatch request with 0 agents',
    message: 'buy TSLAI for $100',
    expectAction: '',
    agents: 0,
  },

  // === MULTI-AGENT ===
  {
    label: 'Multi-agent dispatch',
    message: 'ask all my agents what they think about the market',
    expectAction: 'DISPATCH_TO_AGENTS',
    agents: 2,
  },

  // === EDGE CASES ===
  {
    label: 'Ambiguous - market info with "get"',
    message: 'get me the TSLAI price',
    expectAction: 'CHECK_PERPS',
  },
  {
    label: 'Mixed intent - info + action',
    message: 'check TSLAI price and if it looks good buy some',
    // Real prompt correctly identifies buy intent and dispatches — both CHECK_PERPS
    // (info-first) and DISPATCH_TO_AGENT (delegate entire task) are acceptable
    expectAction: undefined,
  },
];

async function runBatch(
  suite: TestCase[],
  config: Config
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const total = suite.length * config.iterations;
  let completed = 0;

  for (const testCase of suite) {
    const caseConfig = {
      ...config,
      agentCount: testCase.agents ?? config.agentCount,
    };
    const decisions: Decision[] = [];
    const failures: string[] = [];

    for (let i = 0; i < config.iterations; i++) {
      completed++;
      const progress = `[${completed}/${total}]`;

      if (!config.jsonOutput) {
        process.stdout.write(
          `\r${C.dim}${progress} Testing: ${testCase.label || testCase.message.substring(0, 50)}...${C.reset}`
        );
      }

      const prompt = renderPrompt(testCase.message, caseConfig);
      const decision = await callLLM(prompt, caseConfig);
      decisions.push(decision);

      if (testCase.expectAction !== undefined) {
        const expected = testCase.expectAction;
        const actual = decision.action;

        if (expected === '' && actual !== '') {
          failures.push(`Iter ${i + 1}: Expected no action, got "${actual}"`);
        } else if (expected !== '' && actual !== expected) {
          failures.push(
            `Iter ${i + 1}: Expected "${expected}", got "${actual || '(none)'}"`
          );
        }
      }

      if (decision.parseError) {
        failures.push(`Iter ${i + 1}: ${decision.parseError}`);
      }
    }

    results.push({
      testCase,
      decisions,
      passed: failures.length === 0,
      failures,
    });
  }

  if (!config.jsonOutput) {
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
  }

  return results;
}

function displayReport(results: TestResult[], config: Config): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('');
  console.log(
    `${C.bold}═══════════════════════════════════════════════════${C.reset}`
  );
  console.log(`${C.bold} Coordinator Playground — Batch Report${C.reset}`);
  console.log(
    `${C.bold}═══════════════════════════════════════════════════${C.reset}`
  );
  console.log(`${C.dim}Model:${C.reset}       ${config.model}`);
  console.log(`${C.dim}Temperature:${C.reset} ${config.temperature}`);
  console.log(`${C.dim}Agents:${C.reset}      ${config.agentCount}`);
  console.log(`${C.dim}Iterations:${C.reset}  ${config.iterations}`);
  console.log('');

  const passRate = ((passed / total) * 100).toFixed(0);
  const barLen = 30;
  const passBar = Math.round((passed / total) * barLen);
  const bar =
    C.green +
    '█'.repeat(passBar) +
    C.red +
    '█'.repeat(barLen - passBar) +
    C.reset;
  console.log(`${bar}  ${passRate}% (${passed}/${total})`);
  console.log('');

  for (const result of results) {
    const label =
      result.testCase.label || result.testCase.message.substring(0, 40);
    const status = result.passed
      ? `${C.green}PASS${C.reset}`
      : `${C.red}FAIL${C.reset}`;
    const action = result.decisions[0]?.action || '(none)';
    const expected = result.testCase.expectAction ?? '(any)';
    const latency =
      result.decisions.reduce((sum, d) => sum + d.latencyMs, 0) /
      result.decisions.length;

    console.log(`  ${status}  ${C.bold}${label}${C.reset}`);
    console.log(
      `        Expected: ${C.cyan}${expected || '""'}${C.reset}  Got: ${C.cyan}${action || '""'}${C.reset}  ${C.dim}${latency.toFixed(0)}ms${C.reset}`
    );

    if (!result.passed) {
      for (const f of result.failures) {
        console.log(`        ${C.red}> ${f}${C.reset}`);
      }
    }
  }

  console.log('');
  console.log(
    `${C.bold}Results:${C.reset} ${C.green}${passed} passed${C.reset}, ${failed > 0 ? C.red : C.dim}${failed} failed${C.reset}`
  );

  const allLatencies = results.flatMap((r) =>
    r.decisions.map((d) => d.latencyMs)
  );
  const avgLatency =
    allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
  const maxLatency = Math.max(...allLatencies);
  const minLatency = Math.min(...allLatencies);
  console.log(
    `${C.dim}Latency: avg ${avgLatency.toFixed(0)}ms, min ${minLatency}ms, max ${maxLatency}ms${C.reset}`
  );
  console.log('');

  if (failed > 0) {
    console.log(`${C.bold}${C.red}Failed Test Details:${C.reset}`);
    for (const result of results.filter((r) => !r.passed)) {
      console.log(
        `\n  ${C.bold}${result.testCase.label || result.testCase.message}${C.reset}`
      );
      console.log(`  ${C.dim}Message:${C.reset} "${result.testCase.message}"`);
      for (const d of result.decisions) {
        console.log(`  ${C.dim}Thought:${C.reset} ${d.thought}`);
        console.log(`  ${C.dim}Action:${C.reset}  ${d.action || '(none)'}`);
        if (Object.keys(d.parameters).length > 0) {
          console.log(
            `  ${C.dim}Params:${C.reset}  ${JSON.stringify(d.parameters)}`
          );
        }
      }
    }
    console.log('');
  }
}

function displayJsonReport(results: TestResult[], config: Config): void {
  const report = {
    timestamp: new Date().toISOString(),
    config: {
      model: config.model,
      temperature: config.temperature,
      agentCount: config.agentCount,
      iterations: config.iterations,
    },
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      passRate:
        (
          (results.filter((r) => r.passed).length / results.length) *
          100
        ).toFixed(1) + '%',
    },
    results: results.map((r) => ({
      label: r.testCase.label || r.testCase.message,
      message: r.testCase.message,
      expectAction: r.testCase.expectAction,
      passed: r.passed,
      failures: r.failures,
      decisions: r.decisions.map((d) => ({
        action: d.action,
        parameters: d.parameters,
        thought: d.thought,
        isFinish: d.isFinish,
        latencyMs: d.latencyMs,
        parseError: d.parseError,
      })),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
}

// =============================================================================
// Interactive Mode
// =============================================================================

async function runInteractive(config: Config): Promise<void> {
  console.log(`${C.bold}Coordinator Playground${C.reset}`);
  console.log(
    `${C.dim}Model: ${config.model} | Temp: ${config.temperature} | Agents: ${config.agentCount}${C.reset}`
  );
  console.log(
    `${C.dim}Imports: real template, real actions (${userCorePlugin.actions?.length}), real context, real XML parser${C.reset}`
  );
  console.log(
    `${C.dim}Type a message to test. "quit" to exit. "!batch" to run test suite.${C.reset}`
  );
  console.log(
    `${C.dim}Commands: !agents N, !temp N, !model NAME, !verbose, !history msg1|msg2${C.reset}`
  );
  console.log('');

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  process.stdout.write(`${C.cyan}> ${C.reset}`);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes('\n')) {
      const newlineIdx = buffer.indexOf('\n');
      const line = buffer.substring(0, newlineIdx).trim();
      buffer = buffer.substring(newlineIdx + 1);

      if (!line) {
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }

      if (line === 'quit' || line === 'exit') return;

      // Config commands
      if (line.startsWith('!agents ')) {
        config.agentCount = parseInt(line.split(' ')[1] || '1', 10);
        console.log(`${C.dim}Agents set to ${config.agentCount}${C.reset}`);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line.startsWith('!temp ')) {
        config.temperature = parseFloat(line.split(' ')[1] || '0.4');
        console.log(
          `${C.dim}Temperature set to ${config.temperature}${C.reset}`
        );
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line.startsWith('!model ')) {
        config.model = line.split(' ').slice(1).join(' ');
        console.log(`${C.dim}Model set to ${config.model}${C.reset}`);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line === '!verbose') {
        config.verbose = !config.verbose;
        console.log(`${C.dim}Verbose: ${config.verbose}${C.reset}`);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line.startsWith('!history ')) {
        config.conversationHistory = line
          .substring('!history '.length)
          .split('|');
        console.log(
          `${C.dim}History set (${config.conversationHistory.length} messages)${C.reset}`
        );
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line.startsWith('!dispatch-history ')) {
        config.dispatchHistory = line.substring('!dispatch-history '.length);
        console.log(`${C.dim}Dispatch history set${C.reset}`);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line === '!batch') {
        console.log(`\n${C.dim}Running batch test suite...${C.reset}`);
        const results = await runBatch(DEFAULT_TEST_SUITE, config);
        displayReport(results, config);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }
      if (line === '!help') {
        console.log(`${C.dim}Commands:${C.reset}`);
        console.log(`  ${C.cyan}!agents N${C.reset}          Set agent count`);
        console.log(`  ${C.cyan}!temp N${C.reset}            Set temperature`);
        console.log(`  ${C.cyan}!model NAME${C.reset}        Set model`);
        console.log(
          `  ${C.cyan}!verbose${C.reset}           Toggle prompt display`
        );
        console.log(
          `  ${C.cyan}!history m1|m2${C.reset}     Set conversation history`
        );
        console.log(
          `  ${C.cyan}!dispatch-history X${C.reset} Set dispatch history`
        );
        console.log(`  ${C.cyan}!batch${C.reset}             Run test suite`);
        console.log(`  ${C.cyan}quit${C.reset}               Exit`);
        process.stdout.write(`${C.cyan}> ${C.reset}`);
        continue;
      }

      // Regular message — test it
      const prompt = renderPrompt(line, config);

      if (config.verbose) {
        console.log(
          `\n${C.dim}─── PROMPT (${prompt.length} chars) ───${C.reset}`
        );
        console.log(C.dim + prompt + C.reset);
        console.log(`${C.dim}─── END PROMPT ───${C.reset}\n`);
      }

      try {
        const decision = await callLLM(prompt, config);
        displayDecision(decision);
      } catch (err) {
        console.log(
          `${C.red}Error: ${err instanceof Error ? err.message : String(err)}${C.reset}`
        );
      }

      console.log('');
      process.stdout.write(`${C.cyan}> ${C.reset}`);
    }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const { mode, message, batchFile, config } = parseArgs();

  switch (mode) {
    case 'single': {
      const prompt = renderPrompt(message!, config);
      if (config.verbose) {
        console.log(`${C.dim}Prompt: ${prompt.length} chars${C.reset}\n`);
      }
      const decision = await callLLM(prompt, config);
      displayDecision(decision);
      break;
    }

    case 'batch': {
      let suite = DEFAULT_TEST_SUITE;
      if (batchFile) {
        const file = Bun.file(batchFile);
        const content = await file.text();
        suite = JSON.parse(content) as TestCase[];
        console.log(
          `${C.dim}Loaded ${suite.length} test cases from ${batchFile}${C.reset}`
        );
      }

      const results = await runBatch(suite, config);

      if (config.jsonOutput) {
        displayJsonReport(results, config);
      } else {
        displayReport(results, config);
      }

      const failed = results.filter((r) => !r.passed).length;
      if (failed > 0) process.exit(1);
      break;
    }

    case 'interactive':
    default:
      await runInteractive(config);
      break;
  }
}

main()
  .then(() => {
    // Force exit in case transitive imports keep handles open.
    // Safe to force-exit since this is a standalone CLI tool.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
