/**
 * Clawd Code — REPL MODE
 * Interactive multi-turn conversation with persistent history.
 * Type a prompt and get a streamed response. Switch modes inline.
 * Commands: .exit .mode <mode> .model <id> .provider <name> .clear .help
 */

import * as readline from 'node:readline';
import { createAnthropicClient, DEFAULT_CLAUDE_MODEL, isClaudeModel } from '../anthropic.js';
import { createDeepSeekClient } from '../deepseek.js';
import { loadClawdEnv } from '../env.js';
import { createOpenRouterClient } from '../openrouter.js';
import { createXaiClient } from '../xai.js';

type ReplProvider = 'xai' | 'anthropic' | 'deepseek' | 'openrouter';
type SessionMode = 'code' | 'research' | 'trade' | 'general';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ReplConfig {
  provider?: string;
  model?: string;
  stream?: boolean;
  xaiApiKey?: string;
  anthropicApiKey?: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
}

const SYSTEM_PROMPTS: Record<SessionMode, string> = {
  code: 'You are Clawd Code. Ship production TypeScript/Solana code. Be concise. Include imports and types.',
  research: 'You are Clawd Research. Synthesize findings precisely. Cite sources. Flag what needs live verification.',
  trade: 'You are Clawd Trade. Analyze perpetuals markets. Always include preflight checks. Default to PAPER mode.',
  general: 'You are Clawd Code — sovereign AI coding agent for the Clawd ecosystem. Be sharp and precise.',
};

export class ReplMode {
  private history: Message[] = [];
  private provider: ReplProvider;
  private model: string;
  private mode: SessionMode = 'general';

  constructor(private config: ReplConfig) {
    this.provider = this.resolveProvider();
    this.model = config.model ?? this.defaultModel();
  }

  async run(): Promise<void> {
    this.printWelcome();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const prompt = () =>
      new Promise<string>((resolve) => {
        rl.question(this.promptString(), resolve);
      });

    while (true) {
      let input: string;
      try {
        input = (await prompt()).trim();
      } catch {
        break;
      }

      if (!input) continue;

      if (input.startsWith('.')) {
        const done = this.handleCommand(input);
        if (done) break;
        continue;
      }

      await this.respond(input);
    }

    rl.close();
    console.log('\n[REPL] Session ended.');
  }

  private handleCommand(input: string): boolean {
    const [cmd, ...rest] = input.split(' ');
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '.exit':
      case '.quit':
        return true;

      case '.clear':
        this.history = [];
        console.log('[REPL] History cleared.');
        break;

      case '.mode':
        if (['code', 'research', 'trade', 'general'].includes(arg)) {
          this.mode = arg as SessionMode;
          console.log(`[REPL] Mode → ${this.mode}`);
        } else {
          console.log('[REPL] Modes: code | research | trade | general');
        }
        break;

      case '.model':
        if (arg) {
          this.model = arg;
          this.provider = isClaudeModel(arg) ? 'anthropic' : this.provider;
          console.log(`[REPL] Model → ${this.model} (provider: ${this.provider})`);
        }
        break;

      case '.provider':
        if (['xai', 'anthropic', 'openrouter', 'deepseek'].includes(arg)) {
          this.provider = arg as ReplProvider;
          this.model = this.defaultModel();
          console.log(`[REPL] Provider → ${this.provider} | Model → ${this.model}`);
        } else {
          console.log('[REPL] Providers: xai | anthropic | openrouter | deepseek');
        }
        break;

      case '.history':
        for (const m of this.history) {
          const label = m.role === 'user' ? 'You' : 'Clawd';
          console.log(`\n${label}: ${m.content.substring(0, 120)}${m.content.length > 120 ? '…' : ''}`);
        }
        break;

      case '.help':
        this.printHelp();
        break;

      default:
        console.log(`[REPL] Unknown command: ${cmd}. Type .help for commands.`);
    }

    return false;
  }

  private async respond(input: string): Promise<void> {
    this.history.push({ role: 'user', content: input });

    const systemPrompt = SYSTEM_PROMPTS[this.mode];
    process.stdout.write('\nClawd: ');

    try {
      const reply = await this.generate(systemPrompt);
      this.history.push({ role: 'assistant', content: reply });
      process.stdout.write('\n\n');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`\n[REPL] Error: ${msg}\n`);
      this.history.pop();
    }
  }

  private async generate(system: string): Promise<string> {
    const chunks: string[] = [];

    if (this.provider === 'anthropic') {
      const client = createAnthropicClient(this.config.anthropicApiKey);
      if (!client) throw new Error('ANTHROPIC_API_KEY not set');

      for await (const chunk of client.stream({
        model: this.model,
        system,
        messages: this.history,
        maxTokens: 4096,
      })) {
        if (chunk.text) {
          process.stdout.write(chunk.text);
          chunks.push(chunk.text);
        }
      }
      return chunks.join('');
    }

    if (this.provider === 'openrouter') {
      const env = loadClawdEnv();
      const client = createOpenRouterClient(env);
      if (!client) throw new Error('OPENROUTER_API_KEY not set');

      for await (const chunk of client.stream({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...this.history],
        max_tokens: 4096,
      })) {
        if (chunk.content) {
          process.stdout.write(chunk.content);
          chunks.push(chunk.content);
        }
      }
      return chunks.join('');
    }

    if (this.provider === 'deepseek') {
      const client = createDeepSeekClient(this.config.deepSeekApiKey, this.config.deepSeekBaseUrl);
      if (!client) throw new Error('DEEPSEEK_API_KEY not set');

      const response = await client.chat({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...this.history],
        maxTokens: 4096,
        temperature: 0.7,
        thinking: false,
      });
      process.stdout.write(response.content);
      return response.content;
    }

    // xAI
    const client = createXaiClient(this.config.xaiApiKey);
    if (!client) throw new Error('XAI_API_KEY not set');

    const model = this.model === 'grok-4.20-multi-agent' ? 'grok-4.3' : this.model;
    const response = await client.chat({
      model,
      messages: [{ role: 'system', content: system }, ...this.history],
      maxTokens: 4096,
      temperature: 0.7,
    });
    process.stdout.write(response.content);
    return response.content;
  }

  private resolveProvider(): ReplProvider {
    const p = this.config.provider ?? 'xai';
    if (p === 'anthropic' || isClaudeModel(this.config.model ?? '')) return 'anthropic';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'openrouter') return 'openrouter';
    return 'xai';
  }

  private defaultModel(): string {
    switch (this.provider) {
      case 'anthropic': return DEFAULT_CLAUDE_MODEL;
      case 'deepseek':  return 'deepseek-v4-pro';
      case 'openrouter': return 'nex-agi/nex-n2-pro:free';
      default:           return 'grok-4.3';
    }
  }

  private promptString(): string {
    return `\n[${this.mode}:${this.provider}] > `;
  }

  private printWelcome(): void {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🦞 CLAWD CODE — REPL                                    ║
║  Multi-turn interactive session                           ║
╠═══════════════════════════════════════════════════════════╣
║  Provider: ${this.provider.padEnd(14)} Model: ${this.model.substring(0, 22).padEnd(22)}║
║  Mode: ${this.mode.padEnd(52)}║
╠═══════════════════════════════════════════════════════════╣
║  .help for commands  •  .exit to quit                    ║
╚═══════════════════════════════════════════════════════════╝
`);
  }

  private printHelp(): void {
    console.log(`
[REPL] Commands:
  .exit / .quit          End the session
  .clear                 Clear conversation history
  .mode <mode>           Switch mode: code | research | trade | general
  .model <id>            Switch model (e.g. claude-sonnet-4-6, grok-4.3)
  .provider <name>       Switch provider: xai | anthropic | openrouter | deepseek
  .history               Show conversation history
  .help                  Show this help
`);
  }
}
