/**
 * Clawd Code — CODE MODE
 * Write, review, and ship production code
 * Providers: xAI Grok (chat) | Anthropic Claude (streaming) | DeepSeek | OpenRouter (streaming)
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropicClient, DEFAULT_CLAUDE_MODEL, isClaudeModel } from '../anthropic.js';
import { createDeepSeekClient } from '../deepseek.js';
import { loadClawdEnv } from '../env.js';
import { createOpenRouterClient } from '../openrouter.js';
import { createXaiClient } from '../xai.js';

const CODE_SYSTEM = `You are Clawd Code. Ship production TypeScript/Solana code only. No prose. Just code with brief inline comments. Include imports, types, error handling. Format for .ts files.`;

interface CodeConfig {
  provider?: string;
  model?: string;
  stream?: boolean;
  xaiApiKey?: string;
  anthropicApiKey?: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
}

export class CodeMode {
  constructor(private config: CodeConfig) {}

  async run(args: string[]): Promise<void> {
    const command = args.filter((a) => !a.startsWith('--')).join(' ');

    console.log('\n[CODE MODE] Initiating code synthesis...\n');

    const provider = this.resolveProvider();

    if (!command.trim()) {
      console.error('[CODE MODE] No prompt given. Usage: clawd-code code "Build a Jupiter swap bot"');
      return;
    }

    const useStream = this.config.stream ?? false;
    const code = useStream
      ? await this.generateStreaming(command, provider)
      : await this.generateBlocking(command, provider);

    const outputDir = join(process.cwd(), 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const filename = `clawd-code-${Date.now()}.ts`;
    const filepath = join(outputDir, filename);

    writeFileSync(filepath, code);
    console.log(`\n[CODE MODE] Written to: ${filepath}`);

    if (existsSync('tsconfig.json')) {
      console.log('[CODE MODE] Running TypeScript check...');
      try {
        execSync('npx tsc --noEmit', { stdio: 'inherit' });
        console.log('[CODE MODE] ✓ TypeScript check passed');
      } catch {
        console.log('[CODE MODE] ⚠ TypeScript check failed (see above)');
      }
    }
  }

  private resolveProvider(): string {
    const p = this.config.provider as string;
    if (p === 'anthropic' || isClaudeModel(this.config.model ?? '')) return 'anthropic';
    if (p === 'deepseek' || String(this.config.model ?? '').startsWith('deepseek-')) return 'deepseek';
    if (p === 'openrouter') return 'openrouter';
    return 'xai';
  }

  private async generateStreaming(prompt: string, provider: string): Promise<string> {
    process.stdout.write('\n[CODE MODE] Streaming output:\n\n');
    const chunks: string[] = [];

    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return this.fallbackCode(prompt, 'ANTHROPIC_API_KEY not set');

        const model = isClaudeModel(this.config.model ?? '') ? (this.config.model ?? DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL;
        for await (const chunk of client.stream({
          model,
          system: CODE_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 8096,
        })) {
          if (chunk.text) {
            process.stdout.write(chunk.text);
            chunks.push(chunk.text);
          }
        }
        process.stdout.write('\n');
        return chunks.join('');
      }

      if (provider === 'openrouter') {
        const env = loadClawdEnv();
        const client = createOpenRouterClient(env);
        if (!client) return this.fallbackCode(prompt, 'OPENROUTER_API_KEY not set');

        for await (const chunk of client.stream({
          model: this.config.model?.startsWith('grok-') ? client.getDefaultModel() : (this.config.model ?? client.getDefaultModel()),
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          max_tokens: 8096,
        })) {
          if (chunk.content) {
            process.stdout.write(chunk.content);
            chunks.push(chunk.content);
          }
        }
        process.stdout.write('\n');
        return chunks.join('');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`\n[CODE MODE] Streaming error (${provider}): ${msg} — falling back to blocking`);
    }

    // Fall back to blocking for xai/deepseek
    return this.generateBlocking(prompt, provider);
  }

  private async generateBlocking(prompt: string, provider: string): Promise<string> {
    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return this.fallbackCode(prompt, 'ANTHROPIC_API_KEY not set');

        const model = isClaudeModel(this.config.model ?? '') ? (this.config.model ?? DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL;
        console.log(`[CODE MODE] Generating with ${model}...`);
        const response = await client.chat({
          model,
          system: CODE_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 8096,
        });
        return response.content || this.fallbackCode(prompt, 'empty response');
      }

      if (provider === 'deepseek') {
        const client = createDeepSeekClient(this.config.deepSeekApiKey, this.config.deepSeekBaseUrl);
        if (!client) return this.fallbackCode(prompt, 'DEEPSEEK_API_KEY not set');

        const model = String(this.config.model ?? '').startsWith('deepseek-')
          ? (this.config.model ?? 'deepseek-v4-pro')
          : 'deepseek-v4-pro';
        console.log(`[CODE MODE] Generating with ${model}...`);
        const response = await client.chat({
          model,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: 8096,
          temperature: 0.7,
          reasoningEffort: 'high',
          thinking: true,
        });
        return response.content || this.fallbackCode(prompt, 'empty response');
      }

      if (provider === 'openrouter') {
        const env = loadClawdEnv();
        const client = createOpenRouterClient(env);
        if (!client) return this.fallbackCode(prompt, 'OPENROUTER_API_KEY not set');

        const model = this.config.model?.startsWith('grok-') ? client.getDefaultModel() : (this.config.model ?? client.getDefaultModel());
        console.log(`[CODE MODE] Generating with OpenRouter/${model}...`);
        const result = await client.prompt(prompt, {
          model,
          systemPrompt: CODE_SYSTEM,
          maxTokens: 8096,
        });
        return result.content || this.fallbackCode(prompt, 'empty response');
      }

      // xAI default
      const client = createXaiClient(this.config.xaiApiKey);
      if (!client) return this.fallbackCode(prompt, 'XAI_API_KEY not set');

      const model = this.config.model === 'grok-4.20-multi-agent' ? 'grok-4.3' : (this.config.model || 'grok-4.3');
      console.log(`[CODE MODE] Generating with ${model}...`);
      const response = await client.chat({
        model,
        messages: [
          { role: 'system', content: CODE_SYSTEM },
          { role: 'user', content: prompt },
        ],
        maxTokens: 8096,
        temperature: 0.7,
      });
      return response.content || this.fallbackCode(prompt, 'empty response');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[CODE MODE] ${provider} unavailable: ${msg}`);
      return this.fallbackCode(prompt, msg);
    }
  }

  private fallbackCode(prompt: string, reason: string): string {
    return `// Clawd Code — Generated Code
// Note: ${reason}
// Add the appropriate API key to ~/.clawd-code/.env and re-run.

// Original prompt: ${prompt}

export {};
`;
  }
}
