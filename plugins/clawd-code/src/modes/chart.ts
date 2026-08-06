/**
 * Clawd Code — CHART MODE
 * GLM-5.2 chart/report agent with GLM-5V vision and GLM Slide/Poster export.
 */

import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';
import { DEFAULT_MODEL, DEFAULT_TRADE_VISION_MODEL } from '../grok-models.js';
import {
  createZaiAgentClient,
  createZaiClient,
  extractZaiSlideAgentText,
  extractZaiSlideAgentUrls,
  ZAI_AGENT_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_SLIDE_AGENT_ID,
  ZAI_TRADE_VISION_MODEL,
} from '../zai.js';

type ChartArtifactKind = 'analysis' | 'slides' | 'poster';

interface ChartOptions {
  prompt: string;
  imageInput?: string;
  kind: ChartArtifactKind;
  exportArtifact: boolean;
  exportOnly: boolean;
  includePdf: boolean;
  conversationId?: string;
  pageCount?: number;
  model?: string;
  visionModel?: string;
}

export class ChartMode {
  constructor(private config: any) {}

  async run(args: string[]): Promise<void> {
    const options = this.parseArgs(args);
    if (!options.prompt && !options.imageInput && !options.conversationId) {
      this.printHelp();
      return;
    }

    const model = options.model || this.config.zaiChartModel || this.config.model || DEFAULT_MODEL;
    const visionModel = options.visionModel || this.config.zaiChartVisionModel || this.config.zaiTradeVisionModel || DEFAULT_TRADE_VISION_MODEL;

    console.log('\n[CHART MODE] Clawd GLM charting agent');
    console.log(`[CHART MODE] Planner: ${model || ZAI_DEFAULT_MODEL}`);
    console.log(`[CHART MODE] Vision:  ${visionModel || ZAI_TRADE_VISION_MODEL}`);
    if (options.kind !== 'analysis') console.log(`[CHART MODE] Agent:   ${ZAI_SLIDE_AGENT_ID}`);

    let chartFindings = '';
    if (options.imageInput) {
      chartFindings = await this.analyzeChartImage(options, visionModel);
    }

    if (options.kind !== 'analysis') {
      await this.generateSlidePoster(options, model, chartFindings);
      return;
    }

    await this.generateChartPlan(options, model, chartFindings);
  }

  private parseArgs(args: string[]): ChartOptions {
    const promptParts: string[] = [];
    const valueFlags = new Set([
      '--chart',
      '--image',
      '--screenshot',
      '--conversation',
      '--conversation-id',
      '--pages',
      '--model',
      '--vision-model',
    ]);
    let imageInput: string | undefined;
    let kind: ChartArtifactKind = 'analysis';
    let exportArtifact = true;
    let includePdf = true;
    let conversationId: string | undefined;
    let pageCount: number | undefined;
    let model: string | undefined;
    let visionModel: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const next = args[i + 1];
      if (arg === '--slides' || arg === '--slide' || arg === '--deck' || arg === '--ppt' || arg === '--pptx') {
        kind = 'slides';
        continue;
      }
      if (arg === '--poster') {
        kind = 'poster';
        continue;
      }
      if (arg === '--export' || arg === '--pdf') {
        exportArtifact = true;
        includePdf = true;
        continue;
      }
      if (arg === '--no-export') {
        exportArtifact = false;
        continue;
      }
      if (arg === '--no-pdf') {
        includePdf = false;
        continue;
      }
      if (arg.startsWith('--chart=')) {
        imageInput = arg.slice('--chart='.length);
        continue;
      }
      if (arg.startsWith('--image=')) {
        imageInput = arg.slice('--image='.length);
        continue;
      }
      if (arg.startsWith('--screenshot=')) {
        imageInput = arg.slice('--screenshot='.length);
        continue;
      }
      if (arg.startsWith('--conversation=')) {
        conversationId = arg.slice('--conversation='.length);
        continue;
      }
      if (arg.startsWith('--conversation-id=')) {
        conversationId = arg.slice('--conversation-id='.length);
        continue;
      }
      if (arg.startsWith('--pages=')) {
        pageCount = this.parsePositiveInt(arg.slice('--pages='.length));
        continue;
      }
      if (arg.startsWith('--model=')) {
        model = arg.slice('--model='.length);
        continue;
      }
      if (arg.startsWith('--vision-model=')) {
        visionModel = arg.slice('--vision-model='.length);
        continue;
      }
      if (valueFlags.has(arg)) {
        if (arg === '--chart' || arg === '--image' || arg === '--screenshot') imageInput = next;
        if (arg === '--conversation' || arg === '--conversation-id') conversationId = next;
        if (arg === '--pages') pageCount = this.parsePositiveInt(next);
        if (arg === '--model') model = next;
        if (arg === '--vision-model') visionModel = next;
        i++;
        continue;
      }
      if (arg.startsWith('--')) continue;
      promptParts.push(arg);
    }

    const prompt = promptParts.join(' ').trim();
    const lowerPrompt = prompt.toLowerCase();
    if (kind === 'analysis') {
      if (lowerPrompt.includes('poster')) kind = 'poster';
      if (lowerPrompt.includes('slide') || lowerPrompt.includes('deck') || lowerPrompt.includes('ppt')) kind = 'slides';
    }

    const resolvedImageInput = imageInput || this.firstExistingImagePath(args) || this.firstUrl(prompt);
    const exportOnly = Boolean(conversationId && !prompt && !resolvedImageInput);
    if (exportOnly && kind === 'analysis') kind = 'slides';

    return {
      prompt,
      imageInput: resolvedImageInput,
      kind,
      exportArtifact,
      exportOnly,
      includePdf,
      conversationId,
      pageCount,
      model,
      visionModel,
    };
  }

  private parsePositiveInt(value: string | undefined): number | undefined {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private firstUrl(text: string): string | undefined {
    return text.match(/(?:https?:\/\/|data:image\/)[^\s]+/i)?.[0];
  }

  private firstExistingImagePath(args: string[]): string | undefined {
    for (let i = args.length - 1; i >= 0; i--) {
      const candidate = this.expandPath(args[i]);
      const ext = extname(candidate).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async analyzeChartImage(options: ChartOptions, visionModel: string): Promise<string> {
    const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
    if (!client) {
      console.log('\n[CHART MODE] ZAI_API_KEY not set. Skipping GLM-5V image read.');
      return '';
    }

    const imageUrl = this.imageInputToUrl(options.imageInput ?? '');
    const prompt = [
      'You are Clawd Chart Vision. Read this chart, dashboard, trading screenshot, or plotted data image.',
      'Extract: title, axes, units, visible trend, turning points, outliers, support/resistance if market-related, uncertainty, and what chart would best communicate the insight.',
      'If it is a trading chart, keep the output paper-trading only and do not claim live market data beyond what is visible.',
      options.prompt ? `Operator request: ${options.prompt}` : '',
    ].filter(Boolean).join('\n');

    console.log(`\n[CHART MODE] Reading chart image with ${visionModel}...`);
    const response = await client.analyzeImage({
      model: visionModel,
      prompt,
      imageUrl,
      maxTokens: 4096,
      thinking: this.config.zaiThinking ?? 'enabled',
      reasoningEffort: this.config.zaiReasoningEffort ?? 'high',
    });

    if (response.reasoningContent && process.env.ZAI_SHOW_THINKING === 'true') {
      console.log(`\n[CHART MODE] Reasoning:\n${response.reasoningContent}`);
    }

    const findings = response.content || '';
    console.log('\n[CHART MODE] Vision findings:');
    console.log(findings || '(no visual findings returned)');
    return findings;
  }

  private async generateChartPlan(options: ChartOptions, model: string, chartFindings: string): Promise<void> {
    const prompt = this.composePlannerPrompt(options, chartFindings);
    const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
    if (!client) {
      this.printOfflinePlan(options, chartFindings);
      return;
    }

    console.log(`\n[CHART MODE] Planning chart/report with ${model}...`);
    const response = await client.chat({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are Clawd Chart Agent. Produce concise charting, dashboard, and trading-analysis plans with clear metrics, visual encodings, caveats, and next actions.',
        },
        { role: 'user', content: prompt },
      ],
      maxTokens: 4096,
      temperature: 0.3,
      thinking: this.config.zaiThinking ?? 'enabled',
      reasoningEffort: this.config.zaiReasoningEffort ?? 'high',
    });

    if (response.reasoningContent && process.env.ZAI_SHOW_THINKING === 'true') {
      console.log(`\n[CHART MODE] Reasoning:\n${response.reasoningContent}`);
    }
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  CLAWD CHART AGENT                                 ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log(response.content || '(no chart plan returned)');
  }

  private async generateSlidePoster(options: ChartOptions, model: string, chartFindings: string): Promise<void> {
    const agent = createZaiAgentClient(this.config.zaiApiKey, this.config.zaiAgentBaseUrl || ZAI_AGENT_BASE_URL);
    const prompt = this.composeSlidePosterPrompt(options, model, chartFindings);

    if (!agent) {
      if (options.exportOnly) {
        console.log('\n[CHART MODE] ZAI_API_KEY not set. Cannot fetch GLM Slide/Poster export URLs.');
        console.log(`[CHART MODE] Conversation ID: ${options.conversationId}`);
        return;
      }
      console.log('\n[CHART MODE] ZAI_API_KEY not set. GLM Slide/Poster Agent call skipped.');
      console.log('[CHART MODE] Agent prompt that would be sent:\n');
      console.log(prompt);
      return;
    }

    if (options.exportOnly) {
      await this.printSlidePosterExport(agent, options);
      return;
    }

    console.log(`\n[CHART MODE] Calling ${ZAI_SLIDE_AGENT_ID} for ${options.kind}...`);
    const created = await agent.createSlidePoster({
      prompt,
      conversationId: options.conversationId,
      stream: false,
      requestId: `clawd-chart-${Date.now()}`,
    });

    if (created.error?.message) {
      console.error(`[CHART MODE] Agent error: ${created.error.code ?? 'unknown'} ${created.error.message}`);
      return;
    }

    const conversationId = created.conversation_id || options.conversationId;
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  GLM SLIDE/POSTER AGENT                            ║');
    console.log('╚════════════════════════════════════════════════════╝');
    if (created.id) console.log(`Request ID: ${created.id}`);
    if (conversationId) console.log(`Conversation ID: ${conversationId}`);

    const summary = this.compactAgentText(extractZaiSlideAgentText(created));
    if (summary) {
      console.log('\nAgent output:');
      console.log(summary);
    }

    if (!options.exportArtifact || !conversationId) return;

    await this.printSlidePosterExport(agent, { ...options, conversationId });
  }

  private async printSlidePosterExport(
    agent: NonNullable<ReturnType<typeof createZaiAgentClient>>,
    options: ChartOptions,
  ): Promise<void> {
    if (!options.conversationId) return;

    console.log('\n[CHART MODE] Requesting export URLs...');
    const exported = await agent.getSlidePosterExport({
      conversationId: options.conversationId,
      includePdf: options.includePdf,
    });

    if (exported.error?.message) {
      console.error(`[CHART MODE] Export error: ${exported.error.code ?? 'unknown'} ${exported.error.message}`);
      return;
    }

    const urls = extractZaiSlideAgentUrls(exported);
    if (urls.length === 0) {
      console.log('[CHART MODE] No file/image URLs returned yet. Re-run with:');
      console.log(`  clawd-code chart --conversation ${options.conversationId} --export`);
      return;
    }

    console.log('\nExports:');
    for (const item of urls) {
      const label = item.tag ? `${item.type} (${item.tag})` : item.type;
      console.log(`- ${label}: ${item.url}`);
    }
  }

  private composePlannerPrompt(options: ChartOptions, chartFindings: string): string {
    return [
      'Create a practical charting plan for the operator.',
      options.prompt ? `Request: ${options.prompt}` : '',
      chartFindings ? `Vision findings:\n${chartFindings}` : '',
      'Return: key takeaways, recommended chart type(s), data needed, metric definitions, visual encodings, trading caveats if relevant, and next command suggestions.',
    ].filter(Boolean).join('\n\n');
  }

  private composeSlidePosterPrompt(options: ChartOptions, model: string, chartFindings: string): string {
    const artifact = options.kind === 'poster' ? 'poster' : 'slide deck';
    const pageText = options.pageCount ? `Target page count: ${options.pageCount}.` : '';
    return [
      `Create a professional ${artifact} for Clawd Code using GLM chart intelligence.`,
      `Use ${model} level reasoning for content structure and clarity.`,
      options.prompt ? `Operator request: ${options.prompt}` : '',
      pageText,
      chartFindings ? `Chart/vision findings to incorporate:\n${chartFindings}` : '',
      'Prioritize concise executive insight, clear chart labels, source/caveat notes, and visual hierarchy.',
      'For trading/chart content: keep it analytical and paper-trading safe; do not claim unseen live data.',
      'Export-ready deliverable preferred.',
    ].filter(Boolean).join('\n\n');
  }

  private printOfflinePlan(options: ChartOptions, chartFindings: string): void {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  CLAWD CHART AGENT — OFFLINE PLAN                  ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('ZAI_API_KEY is not set, so no GLM call was made.');
    console.log(`Planner model: ${options.model || this.config.zaiChartModel || ZAI_DEFAULT_MODEL}`);
    console.log(`Vision model:  ${options.visionModel || this.config.zaiChartVisionModel || ZAI_TRADE_VISION_MODEL}`);
    if (options.prompt) console.log(`Request: ${options.prompt}`);
    if (chartFindings) console.log(`\nVision findings:\n${chartFindings}`);
    console.log('\nDefault workflow:');
    console.log('1. Use GLM-5V to extract chart structure, trend, anomalies, and caveats.');
    console.log('2. Use GLM-5.2 thinking mode to choose chart types, metrics, and narrative.');
    console.log('3. Use slides_glm_agent with --slides or --poster for an export-ready artifact.');
  }

  private printHelp(): void {
    console.log(`
CLAWD CHART AGENT

Usage:
  clawd-code chart "analyze this SOL chart" --image ./chart.png
  clawd-code chart "weekly Solana market report" --slides --pages 6
  clawd-code poster "launch poster for a new charting model"
  clawd-code slides "AI market analysis deck" --pdf

Options:
  --image|--chart <path|url>       Read chart/screenshot with GLM-5V
  --slides                         Generate a slide deck with slides_glm_agent
  --poster                         Generate a poster with slides_glm_agent
  --conversation <id>              Continue/export a previous slide conversation
  --pages <n>                      Target page count for the prompt
  --no-export                      Skip export URL lookup
  --no-pdf                         Export images only when supported
`);
  }

  private compactAgentText(text: string): string {
    if (text.length <= 3000) return text;
    return `${text.slice(0, 3000)}\n...`;
  }

  private imageInputToUrl(input: string): string {
    if (/^(https?:\/\/|data:image\/)/i.test(input)) return input;

    const expanded = this.expandPath(input);
    if (!existsSync(expanded)) return input;

    const mime = this.mimeFromPath(expanded);
    const base64 = readFileSync(expanded).toString('base64');
    return `data:${mime};base64,${base64}`;
  }

  private expandPath(path: string): string {
    if (path === '~') return process.env.HOME || path;
    if (path.startsWith('~/')) return `${process.env.HOME || ''}${path.slice(1)}`;
    return path;
  }

  private mimeFromPath(path: string): string {
    switch (extname(path).toLowerCase()) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.png':
      default:
        return 'image/png';
    }
  }
}
