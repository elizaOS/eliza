/**
 * Clawd Code — CODE MODE
 * Write, review, and ship production code
 * Default provider: Z.AI GLM-5.2. Streams via SSE like Anthropic & OpenRouter.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropicClient, DEFAULT_CLAUDE_MODEL, isClaudeModel } from '../anthropic.js';
import { createDeepSeekClient } from '../deepseek.js';
import { loadClawdEnv } from '../env.js';
import {
  DEFAULT_MODEL,
  isResponsesOnlyModel,
  normalizeModelId,
  resolveModelForMode,
} from '../grok-models.js';
import { createOpenRouterClient, selectOpenRouterModel } from '../openrouter.js';
import { createXaiClient } from '../xai.js';
import { createZaiClient, ZAI_DEFAULT_MODEL, type ZaiReasoningEffort, type ZaiThinkingType } from '../zai.js';

const CODE_SYSTEM = `You are Clawd Code. Ship production TypeScript/Solana code only. No prose. Just code with brief inline comments. Include imports, types, error handling. Format for .ts files.`;

interface CodeConfig {
  provider?: string;
  model?: string;
  stream?: boolean;
  xaiApiKey?: string;
  anthropicApiKey?: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
  zaiApiKey?: string;
  zaiBaseUrl?: string;
  zaiThinking?: ZaiThinkingType;
  zaiReasoningEffort?: ZaiReasoningEffort;
}

export class CodeMode {
  constructor(private config: CodeConfig) {}

  async run(args: string[]): Promise<void> {
    const command = args.filter((a) => !a.startsWith('--')).join(' ');

    console.log('\n[CODE MODE] Initiating code synthesis...\n');

    const provider = this.resolveProvider();
    const requested = this.config.model ?? DEFAULT_MODEL;
    const model = resolveModelForMode(requested, 'code');
    if (isResponsesOnlyModel(requested) && model !== requested) {
      console.log(`[CODE MODE] ${requested} is responses-only — falling back to ${model} for tool use.`);
    }

    if (!command.trim()) {
      console.error('[CODE MODE] No prompt given. Usage: clawd-code code "Build a Jupiter swap bot"');
      return;
    }

    const useStream = this.config.stream ?? false;
    const code = useStream
      ? await this.generateStreaming(command, provider, model)
      : await this.generateBlocking(command, provider, model);

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
    const p = (this.config.provider ?? 'zai') as string;
    if (p === 'zai' || String(this.config.model ?? '').startsWith('glm-')) return 'zai';
    if (p === 'anthropic' || isClaudeModel(this.config.model ?? '')) return 'anthropic';
    if (p === 'deepseek' || String(this.config.model ?? '').startsWith('deepseek-')) return 'deepseek';
    if (p === 'openrouter') return 'openrouter';
    return 'xai';
  }

  private async generateStreaming(prompt: string, provider: string, model: string): Promise<string> {
    process.stdout.write('\n[CODE MODE] Streaming output:\n\n');
    const chunks: string[] = [];

    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return this.fallbackCode(prompt, 'ANTHROPIC_API_KEY not set');

        const useModel = isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL;
        for await (const chunk of client.stream({
          model: useModel,
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

      if (provider === 'xai') {
        const client = createXaiClient(this.config.xaiApiKey);
        if (!client) return this.fallbackCode(prompt, 'XAI_API_KEY not set');

        for await (const chunk of client.streamChat({
          model,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: 8096,
          temperature: 0.7,
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
        const selection = selectOpenRouterModel({
          prompt,
          mode: 'code',
          requestedModel: this.config.model,
          env,
        });
        process.stdout.write(
          `[CODE MODE] OpenRouter ${selection.explicit ? 'model' : 'route'}: ${selection.model}` +
            `${selection.explicit ? '' : ` (${selection.route}: ${selection.reason})`}\n\n`,
        );

        for await (const chunk of client.stream({
          model: selection.model,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          reasoning: selection.reasoning,
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

      if (provider === 'zai') {
        const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
        if (!client) return this.fallbackCode(prompt, 'ZAI_API_KEY not set');

        const useModel = model.startsWith('glm-') ? model : ZAI_DEFAULT_MODEL;
        for await (const chunk of client.streamChat({
          model: useModel,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: 8096,
          temperature: 1.0,
          thinking: this.config.zaiThinking ?? 'enabled',
          reasoningEffort: this.config.zaiReasoningEffort ?? 'max',
        })) {
          if (chunk.reasoning && process.env.ZAI_SHOW_THINKING === 'true') {
            process.stdout.write(`\x1b[2m${chunk.reasoning}\x1b[0m`);
          }
          if (chunk.text) {
            process.stdout.write(chunk.text);
            chunks.push(chunk.text);
          }
        }
        process.stdout.write('\n');
        return chunks.join('');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`\n[CODE MODE] Streaming error (${provider}): ${msg} — falling back to blocking`);
    }

    // Fall back to blocking for deepseek or on stream failure
    return this.generateBlocking(prompt, provider, model);
  }

  private async generateBlocking(prompt: string, provider: string, model: string): Promise<string> {
    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return this.fallbackCode(prompt, 'ANTHROPIC_API_KEY not set');

        const useModel = isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL;
        console.log(`[CODE MODE] Generating with ${useModel}...`);
        const response = await client.chat({
          model: useModel,
          system: CODE_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 8096,
        });
        return response.content || this.fallbackCode(prompt, 'empty response');
      }

      if (provider === 'deepseek') {
        const client = createDeepSeekClient(this.config.deepSeekApiKey, this.config.deepSeekBaseUrl);
        if (!client) return this.fallbackCode(prompt, 'DEEPSEEK_API_KEY not set');

        const useModel = String(model).startsWith('deepseek-') ? model : 'deepseek-v4-pro';
        console.log(`[CODE MODE] Generating with ${useModel}...`);
        const response = await client.chat({
          model: useModel,
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

        const selection = selectOpenRouterModel({
          prompt,
          mode: 'code',
          requestedModel: this.config.model,
          env,
        });
        console.log(
          `[CODE MODE] Generating with OpenRouter/${selection.model}` +
            `${selection.explicit ? '' : ` (${selection.route}: ${selection.reason})`}...`,
        );
        const result = await client.prompt(prompt, {
          model: selection.model,
          systemPrompt: CODE_SYSTEM,
          reasoning: selection.route === 'fast' ? false : undefined,
          reasoningEffort: selection.reasoning?.effort,
          maxTokens: 8096,
        });
        return result.content || this.fallbackCode(prompt, 'empty response');
      }

      if (provider === 'zai') {
        const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
        if (!client) return this.fallbackCode(prompt, 'ZAI_API_KEY not set');

        const useModel = model.startsWith('glm-') ? model : ZAI_DEFAULT_MODEL;
        console.log(
          `[CODE MODE] Generating with Z.AI/${useModel}` +
            ` (thinking: ${this.config.zaiThinking ?? 'enabled'}, effort: ${this.config.zaiReasoningEffort ?? 'max'})...`,
        );
        const response = await client.chat({
          model: useModel,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: 8096,
          temperature: 1.0,
          thinking: this.config.zaiThinking ?? 'enabled',
          reasoningEffort: this.config.zaiReasoningEffort ?? 'max',
        });
        return response.content || this.fallbackCode(prompt, 'empty response');
      }

      // xAI fallback/provider path.
      const client = createXaiClient(this.config.xaiApiKey);
      if (!client) return this.fallbackCode(prompt, 'XAI_API_KEY not set');

      const useModel = normalizeModelId(model || DEFAULT_MODEL);
      console.log(`[CODE MODE] Generating with ${useModel}...`);
      const response = await client.chat({
        model: useModel,
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
