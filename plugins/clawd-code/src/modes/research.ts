/**
 * Clawd Code — RESEARCH MODE
 * Multi-agent deep research: grok-4.20-multi-agent | Claude | DeepSeek
 * Streaming-first for Anthropic + OpenRouter; blocking for xAI responses API.
 */

import { createAnthropicClient, DEFAULT_CLAUDE_MODEL, isClaudeModel } from '../anthropic.js';
import { createDeepSeekClient } from '../deepseek.js';
import { loadClawdEnv } from '../env.js';
import { createOpenRouterClient } from '../openrouter.js';
import { createXaiClient, type XaiTextResponse } from '../xai.js';

interface ResearchConfig {
  provider?: string;
  model?: string;
  stream?: boolean;
  agentCount?: 4 | 16;
  xaiApiKey?: string;
  anthropicApiKey?: string;
  deepSeekApiKey?: string;
  deepSeekBaseUrl?: string;
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

    console.log('\n[RESEARCH MODE] Initiating multi-agent research...\n');
    console.log(`[RESEARCH MODE] Provider: ${provider} | Agents: ${agentCount}`);
    console.log(`[RESEARCH MODE] Query: ${query}\n`);

    this.printHeader(query, agentCount);

    if (this.config.stream && (provider === 'anthropic' || provider === 'openrouter')) {
      await this.runStreaming(query, provider);
    } else {
      const result = await this.runBlocking(query, provider, agentCount);
      console.log(`\n${result.content || 'No research output returned.'}`);
      if (result.citations.length > 0) {
        console.log('\nCitations:');
        for (const c of result.citations) console.log(`  - ${c}`);
      }
    }

    console.log('\n[RESEARCH MODE] Research complete. Say "code" to generate implementation.');
  }

  private resolveProvider(): string {
    const p = this.config.provider ?? 'xai';
    if (p === 'anthropic' || isClaudeModel(this.config.model ?? '')) return 'anthropic';
    if (p === 'deepseek' || String(this.config.model ?? '').startsWith('deepseek-')) return 'deepseek';
    if (p === 'openrouter') return 'openrouter';
    return 'xai';
  }

  private printHeader(query: string, agentCount: number): void {
    const label = `grok-4.20-multi-agent · ${agentCount} agents`;
    const q = query.substring(0, 52).padEnd(52);
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  RESEARCH MODE — ${label.padEnd(45)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  ${q}  ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }

  private async runStreaming(query: string, provider: string): Promise<void> {
    process.stdout.write('[RESEARCH MODE] Streaming findings:\n\n');

    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) {
          console.error('[RESEARCH MODE] ANTHROPIC_API_KEY not set.');
          return;
        }
        const model = isClaudeModel(this.config.model ?? '') ? (this.config.model ?? DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL;
        for await (const chunk of client.stream({
          model,
          system: RESEARCH_SYSTEM,
          messages: [{ role: 'user', content: query }],
          maxTokens: 8096,
        })) {
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
        for await (const chunk of client.stream({
          model: this.config.model ?? client.getDefaultModel(),
          messages: [
            { role: 'system', content: RESEARCH_SYSTEM },
            { role: 'user', content: query },
          ],
          max_tokens: 8096,
        })) {
          if (chunk.content) process.stdout.write(chunk.content);
        }
        process.stdout.write('\n');
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
  ): Promise<XaiTextResponse> {
    try {
      if (provider === 'anthropic') {
        const client = createAnthropicClient(this.config.anthropicApiKey);
        if (!client) return { content: 'ANTHROPIC_API_KEY not set.', citations: [] };

        const model = isClaudeModel(this.config.model ?? '') ? (this.config.model ?? DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL;
        console.log(`[RESEARCH MODE] Running with ${model}...`);
        const response = await client.chat({
          model,
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

        const model = String(this.config.model ?? '').startsWith('deepseek-')
          ? (this.config.model ?? 'deepseek-v4-pro')
          : 'deepseek-v4-pro';
        console.log(`[RESEARCH MODE] Running DeepSeek ${model} (effort: ${agentCount === 16 ? 'high' : 'medium'})...`);
        const response = await client.chat({
          model,
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

        const model = this.config.model ?? client.getDefaultModel();
        console.log(`[RESEARCH MODE] Running OpenRouter/${model}...`);
        const result = await client.prompt(query, {
          model,
          systemPrompt: RESEARCH_SYSTEM,
          maxTokens: 8096,
        });
        return { content: result.content, citations: [] };
      }

      // xAI — use responses API with web_search + x_search tools
      const client = createXaiClient(this.config.xaiApiKey);
      if (!client) return { content: 'XAI_API_KEY not set.', citations: [] };

      const model = this.config.model ?? 'grok-4.20-multi-agent';
      console.log(`[RESEARCH MODE] Running ${model} with ${agentCount} agents, web_search + x_search...`);
      return await client.responses({
        model,
        reasoning: { effort: agentCount === 16 ? 'high' : 'low' },
        input: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search' }, { type: 'x_search' }, { type: 'code_interpreter' }],
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Research unavailable (${provider}): ${msg}`, citations: [] };
    }
  }
}
