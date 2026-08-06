/**
 * Clawd Code — RESEARCH MODE
 * Deep research. Default: Z.AI GLM-5.2 with thinking mode. Streaming supported
 * for Z.AI, xAI, Anthropic, and OpenRouter.
 */

import { createAnthropicClient, DEFAULT_CLAUDE_MODEL, isClaudeModel } from '../anthropic.js';
import { createDeepSeekClient } from '../deepseek.js';
import { loadClawdEnv } from '../env.js';
import { DEFAULT_RESEARCH_MODEL, normalizeModelId } from '../grok-models.js';
import { createOpenRouterClient, selectOpenRouterModel } from '../openrouter.js';
import { createXaiClient, type XaiTextResponse } from '../xai.js';
import { createZaiClient, ZAI_DEFAULT_MODEL, type ZaiReasoningEffort, type ZaiThinkingType } from '../zai.js';

interface ResearchConfig {
  provider?: string;
  model?: string;
  stream?: boolean;
  agentCount?: 4 | 16;
  xaiApiKey?: string;
  anthropicApiKey?: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
  zaiApiKey?: string;
  zaiBaseUrl?: string;
  zaiThinking?: ZaiThinkingType;
  zaiReasoningEffort?: ZaiReasoningEffort;
}

const RESEARCH_SYSTEM = `You are Clawd Research — a precise, source-aware technical researcher. Synthesize findings across sources. Cite evidence. Flag what requires live verification. Be concise and structured.`;

export class ResearchMode {
  constructor(private config: ResearchConfig) {}

  async run(args: string[]): Promise<void> {
    const query = args.filter((a) => !a.startsWith('--')).join(' ');

    if (!query.trim()) {
      console.error('[RESEARCH MODE] No query given. Usage: clawd-code research "AI agent frameworks 2025"');
      return;
    }

    const provider = this.resolveProvider();
    const agentCount = this.config.agentCount ?? 4;
    const requested = this.config.model ?? DEFAULT_RESEARCH_MODEL;
    const model = normalizeModelId(requested) || DEFAULT_RESEARCH_MODEL;

    console.log('\n[RESEARCH MODE] Initiating multi-agent research...\n');
    console.log(`[RESEARCH MODE] Provider: ${provider} | Agents: ${agentCount}`);
    console.log(`[RESEARCH MODE] Model: ${model}`);
    console.log(`[RESEARCH MODE] Query: ${query}\n`);

    this.printHeader(query, agentCount, model);

    if (this.config.stream) {
      await this.runStreaming(query, provider, agentCount, model);
    } else {
      const result = await this.runBlocking(query, provider, agentCount, model);
      console.log(`\n${result.content || 'No research output returned.'}`);
      if (result.citations.length > 0) {
        console.log('\nCitations:');
        for (const c of result.citations) console.log(`  - ${c}`);
      }
    }

    console.log('\n[RESEARCH MODE] Research complete. Say "code" to generate implementation.');
  }

  private resolveProvider(): string {
    const p = this.config.provider ?? 'zai';
    if (p === 'zai' || String(this.config.model ?? '').startsWith('glm-')) return 'zai';
    if (p === 'anthropic' || isClaudeModel(this.config.model ?? '')) return 'anthropic';
    if (p === 'deepseek' || String(this.config.model ?? '').startsWith('deepseek-')) return 'deepseek';
    if (p === 'openrouter') return 'openrouter';
    return 'xai';
  }

  private printHeader(query: string, agentCount: number, model: string): void {
    const label = `${model} · ${agentCount} agents`;
    const q = query.substring(0, 52).padEnd(52);
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  RESEARCH MODE — ${label.padEnd(45)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  ${q}  ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }

  private async runStreaming(query: string, provider: string, agentCount: 4 | 16, model: string): Promise<void> {
    process.stdout.write('[RESEARCH MODE] Streaming findings:\n\n');

    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) {
          console.error('[RESEARCH MODE] ANTHROPIC_API_KEY not set.');
          return;
        }
        const useModel = isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL;
        for await (const chunk of client.stream({
          model: useModel,
          system: RESEARCH_SYSTEM,
          messages: [{ role: 'user', content: query }],
          maxTokens: 8096,
        })) {
          if (chunk.text) process.stdout.write(chunk.text);
        }
        process.stdout.write('\n');
        return;
      }

      if (provider === 'xai') {
        const client = createXaiClient(this.config.xaiApiKey);
        if (!client) {
          console.error('[RESEARCH MODE] XAI_API_KEY not set.');
          return;
        }
        for await (const chunk of client.streamResponses({
          model,
          input: [{ role: 'user', content: query }],
          tools: [{ type: 'web_search' }, { type: 'x_search' }, { type: 'code_interpreter' }],
          reasoning: { effort: agentCount === 16 ? 'high' : 'low' },
          agentCount,
        })) {
          if (chunk.reasoning) {
            process.stdout.write(`\x1b[2m${chunk.reasoning}\x1b[0m`);
          }
          if (chunk.text) process.stdout.write(chunk.text);
        }
        process.stdout.write('\n');
        return;
      }

      if (provider === 'openrouter') {
        const env = loadClawdEnv();
        const client = createOpenRouterClient(env);
        if (!client) {
          console.error('[RESEARCH MODE] OPENROUTER_API_KEY not set.');
          return;
        }
        const selection = selectOpenRouterModel({
          prompt: query,
          mode: 'research',
          requestedModel: this.config.model,
          env,
        });
        console.log(
          `[RESEARCH MODE] OpenRouter ${selection.explicit ? 'model' : 'route'}: ${selection.model}` +
            `${selection.explicit ? '' : ` (${selection.route}: ${selection.reason})`}`,
        );
        for await (const chunk of client.stream({
          model: selection.model,
          messages: [
            { role: 'system', content: RESEARCH_SYSTEM },
            { role: 'user', content: query },
          ],
          reasoning: selection.reasoning,
          max_tokens: 8096,
        })) {
          if (chunk.content) process.stdout.write(chunk.content);
        }
        process.stdout.write('\n');
        return;
      }

      if (provider === 'zai') {
        const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
        if (!client) {
          console.error('[RESEARCH MODE] ZAI_API_KEY not set.');
          return;
        }
        const useModel = model.startsWith('glm-') ? model : ZAI_DEFAULT_MODEL;
        console.log(
          `[RESEARCH MODE] Streaming Z.AI/${useModel}` +
            ` (thinking: ${this.config.zaiThinking ?? 'enabled'}, effort: ${this.config.zaiReasoningEffort ?? 'max'})...`,
        );
        for await (const chunk of client.streamChat({
          model: useModel,
          messages: [
            { role: 'system', content: RESEARCH_SYSTEM },
            { role: 'user', content: query },
          ],
          maxTokens: 8096,
          temperature: 0.2,
          thinking: this.config.zaiThinking ?? 'enabled',
          reasoningEffort: this.config.zaiReasoningEffort ?? 'max',
        })) {
          if (chunk.reasoning && process.env.ZAI_SHOW_THINKING === 'true') {
            process.stdout.write(`\x1b[2m${chunk.reasoning}\x1b[0m`);
          }
          if (chunk.text) process.stdout.write(chunk.text);
        }
        process.stdout.write('\n');
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`\n[RESEARCH MODE] Streaming error: ${msg}`);
    }
  }

  private async runBlocking(
    query: string,
    provider: string,
    agentCount: 4 | 16,
    model: string,
  ): Promise<XaiTextResponse> {
    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return { content: 'ANTHROPIC_API_KEY not set.', citations: [] };

        const useModel = isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL;
        console.log(`[RESEARCH MODE] Running with ${useModel}...`);
        const response = await client.chat({
          model: useModel,
          system: RESEARCH_SYSTEM,
          messages: [{ role: 'user', content: query }],
          maxTokens: 8096,
          temperature: 0.2,
        });
        return { content: response.content, citations: [] };
      }

      if (provider === 'deepseek') {
        const client = createDeepSeekClient(this.config.deepSeekApiKey, this.config.deepSeekBaseUrl);
        if (!client) return { content: 'DEEPSEEK_API_KEY not set.', citations: [] };

        const useModel = String(model).startsWith('deepseek-') ? model : 'deepseek-v4-pro';
        console.log(`[RESEARCH MODE] Running DeepSeek ${useModel} (effort: ${agentCount === 16 ? 'high' : 'medium'})...`);
        const response = await client.chat({
          model: useModel,
          reasoningEffort: agentCount === 16 ? 'high' : 'medium',
          thinking: true,
          messages: [
            { role: 'system', content: RESEARCH_SYSTEM },
            { role: 'user', content: query },
          ],
          maxTokens: 8096,
          temperature: 0.2,
        });
        return { content: response.content, citations: [] };
      }

      if (provider === 'openrouter') {
        const env = loadClawdEnv();
        const client = createOpenRouterClient(env);
        if (!client) return { content: 'OPENROUTER_API_KEY not set.', citations: [] };

        const selection = selectOpenRouterModel({
          prompt: query,
          mode: 'research',
          requestedModel: this.config.model,
          env,
        });
        console.log(
          `[RESEARCH MODE] Running OpenRouter/${selection.model}` +
            `${selection.explicit ? '' : ` (${selection.route}: ${selection.reason})`}...`,
        );
        const result = await client.prompt(query, {
          model: selection.model,
          systemPrompt: RESEARCH_SYSTEM,
          reasoning: selection.route === 'fast' ? false : undefined,
          reasoningEffort: selection.reasoning?.effort,
          maxTokens: 8096,
        });
        return { content: result.content, citations: [] };
      }

      if (provider === 'zai') {
        const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
        if (!client) return { content: 'ZAI_API_KEY not set.', citations: [] };

        const useModel = model.startsWith('glm-') ? model : ZAI_DEFAULT_MODEL;
        console.log(
          `[RESEARCH MODE] Running Z.AI/${useModel}` +
            ` (thinking: ${this.config.zaiThinking ?? 'enabled'}, effort: ${this.config.zaiReasoningEffort ?? 'max'})...`,
        );
        const response = await client.chat({
          model: useModel,
          messages: [
            { role: 'system', content: RESEARCH_SYSTEM },
            { role: 'user', content: query },
          ],
          maxTokens: 8096,
          temperature: 0.2,
          thinking: this.config.zaiThinking ?? 'enabled',
          reasoningEffort: this.config.zaiReasoningEffort ?? 'max',
        });
        return { content: response.content, citations: [] };
      }

      // xAI — use responses API with web_search + x_search + code_interpreter tools
      const client = createXaiClient(this.config.xaiApiKey);
      if (!client) return { content: 'XAI_API_KEY not set.', citations: [] };

      console.log(`[RESEARCH MODE] Running ${model} with ${agentCount} agents, web_search + x_search...`);
      return await client.responses({
        model,
        reasoning: { effort: agentCount === 16 ? 'high' : 'low' },
        input: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search' }, { type: 'x_search' }, { type: 'code_interpreter' }],
        agentCount,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Research unavailable (${provider}): ${msg}`, citations: [] };
    }
  }
}
