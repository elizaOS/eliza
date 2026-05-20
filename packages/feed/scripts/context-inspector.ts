#!/usr/bin/env bun

/**
 * Context Inspector — Dev tool for NPC and autonomous agent prompt debugging
 *
 * Shows exactly what context an NPC or autonomous agent receives for trading
 * and posting decisions. Renders the full prompt and reports on token usage,
 * truncation, ghost variables, and position visibility.
 *
 * Uses the canonical engine pipelines:
 * - Trading: MarketContextService → shared dashboard formatters → renderPrompt(npcMarketDecisions)
 * - Posting: buildComprehensiveNPCContext → formatComprehensiveContext → buildCharacterFeedContext → renderPrompt(ambientPosts)
 *
 * Usage (NPCs):
 *   bun run inspect:context -- --npc ailon-musk --type trading
 *   bun run inspect:context -- --npc all --type both --summary
 *   bun run inspect:context -- --npc ailon-musk --type posting --raw
 *
 * Usage (Autonomous Agents):
 *   bun run inspect:context -- --agent <userId> --raw
 *   bun run inspect:context -- --agent <userId>
 */

import { parseArgs } from 'node:util';
import {
  ambientPosts,
  buildCharacterFeedContext,
  buildComprehensiveNPCContext,
  buildPhaseContext,
  calculatePortfolioExposure,
  formatCharacterInfoWithEntropy,
  formatComprehensiveContext,
  formatMarketDataTable,
  formatSingleNPCDashboard,
  generateWorldContext,
  getShuffledExamplesText,
  getTimeOfDayEnergy,
  MarketContextService,
  MarketDecisionEngine,
  type NPCMarketContext,
  npcMarketDecisions,
  renderPrompt,
  StaticDataRegistry,
} from '@feed/engine';
import type { Actor } from '@feed/shared';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function warn(msg: string) {
  console.log(`${YELLOW}WARNING: ${msg}${RESET}`);
}
function error(msg: string) {
  console.log(`${RED}ERROR: ${msg}${RESET}`);
}
function heading(msg: string) {
  console.log(`\n${BOLD}${CYAN}=== ${msg} ===${RESET}`);
}
function subheading(msg: string) {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

// ---------------------------------------------------------------------------
// Token estimation (matches engine: Math.ceil(text.length / 4))
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    npc: { type: 'string', default: '' },
    agent: { type: 'string', default: '' },
    type: { type: 'string', default: 'trading' },
    diff: { type: 'boolean', default: false },
    summary: { type: 'boolean', default: false },
    raw: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

const npcArg = args.npc || '';
const agentArg = args.agent || '';
const validTypes = new Set(['trading', 'posting', 'both']);
if (args.type && !validTypes.has(args.type)) {
  console.error(
    `${RED}Invalid --type "${args.type}". Must be one of: trading, posting, both${RESET}`
  );
  process.exit(1);
}
const inspectType = (args.type || 'trading') as 'trading' | 'posting' | 'both';
const showDiff = args.diff ?? false;
const showSummary = args.summary ?? false;
const showRaw = args.raw ?? false;

if (!npcArg && !agentArg) {
  console.log(`Usage:
  bun run inspect:context -- --npc <id|all> [options]     # Inspect NPC context
  bun run inspect:context -- --agent <userId> [options]    # Inspect autonomous agent context

Options:
  --npc <id>           NPC ID (e.g. ailon-musk) or "all" for summary
  --agent <userId>     Autonomous agent user ID (from DB)
  --type <type>        trading | posting | both (default: trading)
  --diff               Side-by-side comparison (only with --type both)
  --summary            Aggregate stats instead of full prompt
  --raw                Output raw rendered prompt text`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Template variable extraction
// ---------------------------------------------------------------------------
function extractTemplateVars(template: string): string[] {
  const matches = template.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '')))];
}

// ---------------------------------------------------------------------------
// Trading context inspection
// Uses MarketContextService + shared dashboard formatters + renderPrompt
// ---------------------------------------------------------------------------
async function inspectTradingContext(npcId: string): Promise<{
  sections: Array<{
    name: string;
    tokens: number;
    populated: boolean;
    truncated?: boolean;
  }>;
  ghostVars: string[];
  totalTokens: number;
  positionVisibility: { total: number; shown: number };
  rawPrompt?: string;
  rawContext: NPCMarketContext;
}> {
  const svc = new MarketContextService();
  const ctx = await svc.buildContextForNPC(npcId);

  const worldContext = await generateWorldContext();
  const examples = getShuffledExamplesText();
  const npcsList = formatSingleNPCDashboard(ctx);
  const marketTable = formatMarketDataTable(ctx);

  const validNpcIds = ctx.npcId;
  const allTickers = new Set<string>();
  ctx.perpMarkets.forEach((m) => allTickers.add(m.ticker));
  const validTickers =
    allTickers.size > 0 ? Array.from(allTickers).join(', ') : 'N/A';

  // Use the real MarketDecisionEngine's private methods via prototype access
  // to fetch narrative data exactly as the engine does (DRY — no reimplementation)
  const stubLlm = { getProvider: () => 'groq' } as never;
  const engine = new MarketDecisionEngine(stubLlm, svc);
  const enginePrivate = engine as never as Record<string, Function>;

  const resolvedQuestionsContext: string =
    await enginePrivate['getCachedResolvedQuestions'].call(engine);
  const previousTrades: string =
    await enginePrivate['getCachedPreviousTrades'].call(engine);
  const marketSignalAnalysis: string = enginePrivate[
    'formatMarketSignals'
  ].call(engine, [ctx]);
  // Fetch momentum alerts exactly as the real engine does — same method, same cache key
  const momentumAlerts: string =
    await enginePrivate['getCachedMomentumAlerts'].call(engine);

  // Assemble the exact same variables the real engine passes to renderPrompt
  const vars: Record<string, string> = {
    examples,
    marketTable,
    npcCount: '1',
    npcsList,
    validNpcIds,
    validTickers,
    realityGrounding: worldContext.realityGrounding,
    activeQuestions: '',
    recentEvents: '',
    richGameContext: worldContext.richGameContext || '',
    eventMarketSignals: 'No event-market signals available',
    resolvedQuestionsContext,
    previousTrades,
    marketSignalAnalysis,
    momentumAlerts,
  };

  // Render and measure
  const rendered = renderPrompt(npcMarketDecisions, vars, {
    allowEmpty: true,
  });

  // Find ghost vars (in template but not in vars)
  const templateVars = extractTemplateVars(npcMarketDecisions.template);
  // Auto-injected date vars from renderPrompt
  const autoVars = new Set([
    'currentDateTime',
    'currentDate',
    'currentTime',
    'currentYear',
    'currentMonth',
    'currentDay',
  ]);
  const suppliedVarKeys = new Set([...Object.keys(vars), ...autoVars]);
  const ghostVars = templateVars.filter((v) => !suppliedVarKeys.has(v));

  // Build section report
  const sections = Object.entries(vars).map(([name, value]) => ({
    name,
    tokens: estimateTokens(value),
    populated: value.trim().length > 0,
  }));

  // Position visibility — dashboard now shows all positions
  const totalPositions = ctx.currentPositions.length;
  const shownPositions = (npcsList.match(/\[ID:/g) || []).length;

  return {
    sections,
    ghostVars,
    totalTokens: estimateTokens(rendered),
    positionVisibility: { total: totalPositions, shown: shownPositions },
    rawPrompt: showRaw ? rendered : undefined,
    rawContext: ctx,
  };
}

// ---------------------------------------------------------------------------
// Posting context inspection
// Uses the canonical pipeline: buildComprehensiveNPCContext →
// formatComprehensiveContext → buildCharacterFeedContext →
// renderPrompt(ambientPosts, ...)
// ---------------------------------------------------------------------------
async function inspectPostingContext(npcId: string): Promise<{
  sections: Array<{ name: string; tokens: number; populated: boolean }>;
  totalTokens: number;
  rawPrompt?: string;
}> {
  const actor = StaticDataRegistry.getActor(npcId);
  if (!actor) {
    error(`Actor not found: ${npcId}`);
    return { sections: [], totalTokens: 0 };
  }

  // 1. Build comprehensive context (same as FeedGenerator.buildRichCharacterContext)
  // Cast StaticActor → Actor: StaticActor is a structural subset loaded from JSON;
  // buildComprehensiveNPCContext only reads fields that overlap.
  const currentDay = 15; // Mid-game default for inspection
  const comprehensiveContext = await buildComprehensiveNPCContext(
    actor as Actor,
    currentDay
  );

  // 2. Format comprehensive context into text sections
  const comprehensiveContextText =
    formatComprehensiveContext(comprehensiveContext);

  // 3. Format character info with entropy (same as FeedGenerator)
  const relationshipContextStr =
    comprehensiveContext.relationships
      ?.map(
        (r) =>
          `${r.strength} ${r.type} with ${r.otherActorName} (${r.sentiment})${r.history ? ` - ${r.history}` : ''}`
      )
      .join('\n') || '';

  const positionsContextStr =
    comprehensiveContext.marketPositions
      ?.map(
        (p) =>
          `${p.market}: ${p.side}${p.pnl !== undefined ? ` (${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)})` : ''}`
      )
      .join('\n') || '';

  // StaticActor doesn't carry persona data (it's loaded from static JSON).
  // The persona fields are optional in formatCharacterInfoWithEntropy, so
  // we pass what StaticActor has and let persona-dependent sections be skipped.
  const characterInfo = formatCharacterInfoWithEntropy({
    name: actor.name,
    description: actor.description || undefined,
    profileDescription: actor.profileDescription || undefined,
    domain: actor.domain || undefined,
    postStyle: actor.postStyle || undefined,
    postExample: actor.postExample || undefined,
    voice: actor.voice || undefined,
    personality: actor.personality || undefined,
    affiliations: actor.affiliations || undefined,
    tier: actor.tier || undefined,
    relationshipContext: relationshipContextStr || undefined,
    currentPositions: positionsContextStr || undefined,
  });

  // 4. Build full character feed context with entropy-based section ordering
  const fullCharacterContext = buildCharacterFeedContext({
    characterInfo,
    comprehensiveContext: comprehensiveContextText,
  });

  // 5. Build phase and world context
  const worldContext = await generateWorldContext();
  const phaseContext = buildPhaseContext(currentDay);
  const hour = Math.floor(Math.random() * 24);

  // 6. Render the actual prompt template (ambientPosts)
  const rendered = renderPrompt(
    ambientPosts,
    {
      day: currentDay.toString(),
      progressContext: phaseContext,
      atmosphereContext:
        'Increasing activity and developments in various areas. Individual perspectives vary.',
      trendContext: '',
      timeEnergy: getTimeOfDayEnergy(hour),
      characterName: actor.name,
      characterInfo: fullCharacterContext,
      ...worldContext,
    },
    { allowEmpty: true }
  );

  // Build section report from the context components
  const sections: Array<{ name: string; tokens: number; populated: boolean }> =
    [];

  sections.push({
    name: 'characterInfo (with entropy)',
    tokens: estimateTokens(characterInfo),
    populated: characterInfo.length > 0,
  });
  sections.push({
    name: 'comprehensiveContext',
    tokens: estimateTokens(comprehensiveContextText),
    populated: comprehensiveContextText.length > 0,
  });
  sections.push({
    name: 'fullCharacterContext (composed)',
    tokens: estimateTokens(fullCharacterContext),
    populated: fullCharacterContext.length > 0,
  });
  sections.push({
    name: 'realityGrounding',
    tokens: estimateTokens(worldContext.realityGrounding),
    populated: worldContext.realityGrounding.length > 0,
  });
  sections.push({
    name: 'worldActors (characterRoster)',
    tokens: estimateTokens(worldContext.worldActors),
    populated: worldContext.worldActors.length > 0,
  });
  sections.push({
    name: 'richGameContext',
    tokens: estimateTokens(worldContext.richGameContext || ''),
    populated: (worldContext.richGameContext || '').length > 0,
  });
  sections.push({
    name: 'phaseContext',
    tokens: estimateTokens(phaseContext),
    populated: phaseContext.length > 0,
  });
  sections.push({
    name: 'timeEnergy',
    tokens: estimateTokens(getTimeOfDayEnergy(hour)),
    populated: true,
  });

  // Detailed sub-sections from comprehensiveContext
  if (comprehensiveContext.personalEvents.length > 0) {
    sections.push({
      name: '  └ personalEvents',
      tokens: estimateTokens(
        comprehensiveContext.personalEvents.map((e) => e.description).join('\n')
      ),
      populated: true,
    });
  }
  if (comprehensiveContext.recentEvents.length > 0) {
    sections.push({
      name: '  └ recentEvents',
      tokens: estimateTokens(
        comprehensiveContext.recentEvents.map((e) => e.description).join('\n')
      ),
      populated: true,
    });
  }
  if (comprehensiveContext.previousPosts.length > 0) {
    sections.push({
      name: '  └ previousPosts',
      tokens: estimateTokens(
        comprehensiveContext.previousPosts.map((p) => p.content).join('\n')
      ),
      populated: true,
    });
  }
  if ((comprehensiveContext.relationships?.length ?? 0) > 0) {
    sections.push({
      name: '  └ relationships',
      tokens: estimateTokens(relationshipContextStr),
      populated: true,
    });
  }
  if ((comprehensiveContext.marketPositions?.length ?? 0) > 0) {
    sections.push({
      name: '  └ marketPositions',
      tokens: estimateTokens(positionsContextStr),
      populated: true,
    });
  }
  if ((comprehensiveContext.relatedQuestions?.length ?? 0) > 0) {
    sections.push({
      name: '  └ relatedQuestions',
      tokens: estimateTokens(
        (comprehensiveContext.relatedQuestions ?? [])
          .map((q) => q.text)
          .join('\n')
      ),
      populated: true,
    });
  }

  const totalTokens = estimateTokens(rendered);

  return {
    sections,
    totalTokens,
    rawPrompt: showRaw ? rendered : undefined,
  };
}

// ---------------------------------------------------------------------------
// Autonomous agent context inspection
// ---------------------------------------------------------------------------
async function inspectAgentContext(agentUserId: string): Promise<{
  sections: Array<{
    name: string;
    tokens: number;
    populated: boolean;
    count?: number;
  }>;
  totalTokens: number;
  rawPrompt?: string;
}> {
  // Dynamic imports from @feed/agents (not in @feed/engine)
  const {
    getPredictionMarkets,
    getPerpMarkets,
    getAgentPositions,
    getRecentPosts,
    getAgentGroupChats,
    getAgentOwnPosts,
  } = await import('../packages/agents/src/autonomous/utils/context-gatherers');
  const { gatherPendingCommentReplies, gatherPendingChatMessages } =
    await import(
      '../packages/agents/src/autonomous/utils/interaction-gatherers'
    );
  const { buildMultiStepDecisionPrompt } = await import(
    '../packages/agents/src/autonomous/templates/multi-step-decision'
  );
  const { getAgentContext } = await import(
    '../packages/agents/src/autonomous/agent-context'
  );
  const { db, eq, users } = await import('@feed/db');

  // Verify agent exists
  const [user] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);

  if (!user) {
    error(`Agent user not found: ${agentUserId}`);
    process.exit(1);
  }

  const agentCtx = await getAgentContext(agentUserId);
  const agentName = agentCtx.displayName || user.displayName || agentUserId;

  // Gather all context (same as MultiStepExecutor.gatherContext)
  const [
    predictionMarkets,
    perpMarkets,
    agentPositions,
    recentPosts,
    pendingCommentReplies,
    pendingChatMessages,
    agentGroupChats,
    agentOwnPosts,
  ] = await Promise.all([
    getPredictionMarkets(),
    getPerpMarkets(),
    getAgentPositions(agentUserId),
    getRecentPosts(agentUserId),
    gatherPendingCommentReplies(agentUserId).catch(() => []),
    gatherPendingChatMessages(agentUserId).catch(() => []),
    getAgentGroupChats(agentUserId),
    getAgentOwnPosts(agentUserId),
  ]);

  const { generateWorldContext, WalletService } = await import(
    '@feed/engine'
  );
  let balance = 0;
  let pnl = 0;
  try {
    const walletBalance = await WalletService.getBalance(agentUserId);
    balance = walletBalance.balance;
    pnl = walletBalance.lifetimePnL;
  } catch {
    // NPC or missing wallet — use 0
  }

  // Fetch world context (same as MultiStepExecutor.gatherContext)
  const worldCtx = await generateWorldContext({
    includeActors: true,
    includeMarkets: false,
    includePredictions: false,
    includeTrades: false,
    realityGroundingLevel: 'concise',
    maxActors: 30,
  });

  const sections: Array<{
    name: string;
    tokens: number;
    populated: boolean;
    count?: number;
  }> = [];

  // Build the actual prompt to measure it
  const context = {
    balance,
    pnl,
    openPositions:
      agentPositions.predictions.length + agentPositions.perps.length,
    pendingCommentReplies: pendingCommentReplies.slice(0, 3),
    pendingChatMessages: pendingChatMessages.slice(0, 3),
    enabledFeatures: ['TRADING', 'POSTING', 'COMMENTING', 'DMS', 'GROUP_CHATS'],
    predictionMarkets,
    perpMarkets,
    recentPosts,
    agentPositions,
    groupChats: agentGroupChats,
    agentOwnPosts,
    worldContext: {
      realityGrounding: worldCtx.realityGrounding,
      worldActors: worldCtx.worldActors,
    },
  };

  let renderedPrompt: string;
  try {
    renderedPrompt = buildMultiStepDecisionPrompt({
      agentName,
      iterationCount: 1,
      maxIterations: 5,
      traceActionResults: [],
      context: context as never,
      isNpc: agentCtx.isNpc,
    });
  } catch (e) {
    warn(`Prompt render error: ${e instanceof Error ? e.message : String(e)}`);
    renderedPrompt =
      '[Failed to render prompt — missing template dependencies]';
  }

  // Section breakdown
  sections.push({
    name: 'identity',
    tokens: estimateTokens(agentName),
    populated: true,
  });
  sections.push({
    name: 'balance & PnL',
    tokens: estimateTokens(`$${balance} / PnL: $${pnl}`),
    populated: balance > 0 || pnl !== 0,
  });

  const worldContextText =
    worldCtx.realityGrounding + '\n' + worldCtx.worldActors;
  sections.push({
    name: 'worldContext',
    tokens: estimateTokens(worldContextText),
    populated: worldContextText.trim().length > 0,
  });

  const predMktsText = predictionMarkets
    .map((m: { question: string }) => m.question)
    .join('\n');
  sections.push({
    name: 'predictionMarkets',
    tokens: estimateTokens(predMktsText),
    populated: predictionMarkets.length > 0,
    count: predictionMarkets.length,
  });

  const perpMktsText = perpMarkets
    .map((m: { name: string }) => m.name)
    .join('\n');
  sections.push({
    name: 'perpMarkets',
    tokens: estimateTokens(perpMktsText),
    populated: perpMarkets.length > 0,
    count: perpMarkets.length,
  });

  const predPositions = agentPositions.predictions || [];
  const perpPositions = agentPositions.perps || [];
  sections.push({
    name: 'positions (prediction)',
    tokens: estimateTokens(JSON.stringify(predPositions)),
    populated: predPositions.length > 0,
    count: predPositions.length,
  });
  sections.push({
    name: 'positions (perp)',
    tokens: estimateTokens(JSON.stringify(perpPositions)),
    populated: perpPositions.length > 0,
    count: perpPositions.length,
  });

  const postsText = recentPosts
    .map((p: { content: string }) => p.content)
    .join('\n');
  sections.push({
    name: 'recentPosts',
    tokens: estimateTokens(postsText),
    populated: recentPosts.length > 0,
    count: recentPosts.length,
  });

  const ownPostsText = agentOwnPosts
    .map((p: { content: string }) => p.content)
    .join('\n');
  sections.push({
    name: 'agentOwnPosts',
    tokens: estimateTokens(ownPostsText),
    populated: agentOwnPosts.length > 0,
    count: agentOwnPosts.length,
  });

  sections.push({
    name: 'pendingCommentReplies',
    tokens: estimateTokens(JSON.stringify(pendingCommentReplies.slice(0, 3))),
    populated: pendingCommentReplies.length > 0,
    count: pendingCommentReplies.length,
  });

  sections.push({
    name: 'pendingChatMessages',
    tokens: estimateTokens(JSON.stringify(pendingChatMessages.slice(0, 3))),
    populated: pendingChatMessages.length > 0,
    count: pendingChatMessages.length,
  });

  sections.push({
    name: 'groupChats',
    tokens: estimateTokens(JSON.stringify(agentGroupChats)),
    populated: agentGroupChats.length > 0,
    count: agentGroupChats.length,
  });

  const totalTokens = estimateTokens(renderedPrompt);

  return {
    sections,
    totalTokens,
    rawPrompt: showRaw ? renderedPrompt : undefined,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function printSectionReport(
  sections: Array<{
    name: string;
    tokens: number;
    populated: boolean;
    truncated?: boolean;
  }>
) {
  const maxName = Math.max(...sections.map((s) => s.name.length), 8);
  console.log(`${'Section'.padEnd(maxName)}  Tokens    Status`);
  console.log('-'.repeat(maxName + 30));

  for (const s of sections) {
    const status = s.populated
      ? `${GREEN}populated${RESET}`
      : `${DIM}empty${RESET}`;
    const truncNote = s.truncated ? ` ${YELLOW}(truncated)${RESET}` : '';
    console.log(
      `${s.name.padEnd(maxName)}  ${String(s.tokens).padStart(6)}    ${status}${truncNote}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  heading('Context Inspector');

  // Handle agent mode
  if (agentArg) {
    heading(`Autonomous Agent Context: ${agentArg}`);
    try {
      const result = await inspectAgentContext(agentArg);

      if (showRaw && result.rawPrompt) {
        console.log(result.rawPrompt);
      } else {
        subheading('Section Breakdown');
        const maxName = Math.max(
          ...result.sections.map((s) => s.name.length),
          8
        );
        console.log(`${'Section'.padEnd(maxName)}  Tokens    Count   Status`);
        console.log('-'.repeat(maxName + 40));
        for (const s of result.sections) {
          const status = s.populated
            ? `${GREEN}populated${RESET}`
            : `${DIM}empty${RESET}`;
          const count =
            s.count !== undefined ? String(s.count).padStart(5) : '    -';
          console.log(
            `${s.name.padEnd(maxName)}  ${String(s.tokens).padStart(6)}    ${count}   ${status}`
          );
        }

        subheading('Token Budget');
        console.log(`  Total rendered prompt tokens: ${result.totalTokens}`);
        console.log(
          `  Budget: 30,000 tokens | Utilization: ${((result.totalTokens / 30000) * 100).toFixed(1)}%`
        );

        subheading('Data Limits');
        console.log('  Prediction markets: max 8 (24h window)');
        console.log('  Perp markets: max 8 (top by price)');
        console.log('  Positions: max 10 each type');
        console.log('  Recent posts: max 8 (24h window)');
        console.log('  Pending replies: max 3');
        console.log('  Pending chats: max 3');
        console.log('  Group chats: max 5');
        console.log('  Own posts: max 5');
      }
    } catch (e) {
      error(
        `Failed to build agent context: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    process.exit(0);
  }

  // Validate NPC
  if (npcArg !== 'all') {
    const actor = StaticDataRegistry.getActor(npcArg);
    if (!actor) {
      error(`NPC not found: ${npcArg}`);
      const allIds = StaticDataRegistry.getActorIds().slice(0, 10);
      console.log(`Available NPCs (first 10): ${allIds.join(', ')}`);
      process.exit(1);
    }
  }

  // Handle "all" summary mode
  if (npcArg === 'all') {
    heading('All NPCs Summary');
    const allActors = StaticDataRegistry.getAllActors().filter(
      (a) => !a.isTest && !a.name.includes('Group Test')
    );

    if (inspectType === 'trading' || inspectType === 'both') {
      subheading(`Trading Context (${allActors.length} NPCs)`);
      const svc = new MarketContextService();
      let contexts: Map<string, NPCMarketContext>;
      try {
        contexts = await svc.buildContextForAllNPCs();
      } catch (e) {
        warn(
          `Could not build contexts from DB: ${e instanceof Error ? e.message : String(e)}`
        );
        console.log('Ensure DATABASE_URL is set and the database has data.');
        process.exit(1);
      }

      let totalTokensAll = 0;
      let totalPositionsAll = 0;
      let npcsWithPositions = 0;

      for (const actor of allActors) {
        const ctx = contexts.get(actor.id);
        if (!ctx) continue;
        const dashboard = formatSingleNPCDashboard(ctx);
        const tokens = estimateTokens(dashboard);
        totalTokensAll += tokens;
        const posCount = ctx.currentPositions.length;
        totalPositionsAll += posCount;
        if (posCount > 0) npcsWithPositions++;

        if (!showSummary) {
          const exposure = calculatePortfolioExposure(
            ctx.availableBalance,
            ctx.currentPositions
          );
          console.log(
            `  ${actor.id.padEnd(24)} ${String(tokens).padStart(5)} tokens  ${posCount} positions  $${ctx.availableBalance.toLocaleString()} balance  ${exposure.toFixed(1)}% exposure`
          );
        }
      }

      console.log(
        `\nTotal dashboard tokens: ${totalTokensAll} | NPCs with positions: ${npcsWithPositions}/${allActors.length} | Total positions: ${totalPositionsAll}`
      );
    }

    if (inspectType === 'posting' || inspectType === 'both') {
      subheading(`Posting Context (${allActors.length} NPCs)`);

      let totalTokensAll = 0;
      let minTokens = Number.POSITIVE_INFINITY;
      let maxTokens = 0;
      let totalSectionsPopulated = 0;
      let totalSections = 0;

      for (const actor of allActors) {
        const result = await inspectPostingContext(actor.id);
        totalTokensAll += result.totalTokens;
        if (result.totalTokens < minTokens) minTokens = result.totalTokens;
        if (result.totalTokens > maxTokens) maxTokens = result.totalTokens;
        totalSectionsPopulated += result.sections.filter(
          (s) => s.populated
        ).length;
        totalSections += result.sections.length;

        if (!showSummary) {
          console.log(
            `  ${actor.id.padEnd(24)} ${String(result.totalTokens).padStart(5)} tokens  ${result.sections.filter((s) => s.populated).length}/${result.sections.length} sections populated`
          );
        }
      }

      const avgTokens =
        allActors.length > 0
          ? Math.round(totalTokensAll / allActors.length)
          : 0;
      console.log(
        `\nPosting context: ${allActors.length} NPCs | Total: ${totalTokensAll} tokens | Avg: ${avgTokens} | Min: ${minTokens === Number.POSITIVE_INFINITY ? 0 : minTokens} | Max: ${maxTokens}`
      );
      console.log(
        `Sections populated: ${totalSectionsPopulated}/${totalSections} (${totalSections > 0 ? ((totalSectionsPopulated / totalSections) * 100).toFixed(1) : 0}%)`
      );
    }

    process.exit(0);
  }

  // Single NPC inspection
  if (inspectType === 'trading' || inspectType === 'both') {
    heading(`Trading Context: ${npcArg}`);
    try {
      const result = await inspectTradingContext(npcArg);

      if (showRaw && result.rawPrompt) {
        console.log(result.rawPrompt);
      } else {
        subheading('Section Breakdown');
        printSectionReport(result.sections);

        subheading('Position Visibility');
        console.log(
          `  Total positions: ${result.positionVisibility.total} | Shown in prompt: ${result.positionVisibility.shown}`
        );
        if (result.positionVisibility.total > result.positionVisibility.shown) {
          warn(
            `${result.positionVisibility.total - result.positionVisibility.shown} positions hidden from prompt (max 3 shown)`
          );
        }

        subheading('Token Budget');
        console.log(`  Total prompt tokens: ${result.totalTokens}`);

        if (result.ghostVars.length > 0) {
          subheading('Ghost Variables');
          for (const v of result.ghostVars) {
            console.log(
              `  ${RED}{{${v}}}${RESET} - in template but not supplied`
            );
          }
        } else {
          console.log(`\n${GREEN}No ghost variables detected.${RESET}`);
        }

        // Truncation report — reuse rawContext from inspectTradingContext
        subheading('Truncation Report');
        const ctx = result.rawContext;
        const truncations = [];
        if (ctx.recentPosts.length >= 50)
          truncations.push('  Posts: capped at 50 (may have more)');
        if (ctx.recentEvents.length >= 30)
          truncations.push('  Events: capped at 30 (may have more)');
        if (ctx.predictionMarkets.length >= 15)
          truncations.push(
            '  Prediction markets: capped at 15 (may have more)'
          );
        if (ctx.groupChatMessages.length > 5)
          truncations.push(
            `  Group chat: ${ctx.groupChatMessages.length} messages, 5 shown in dashboard`
          );
        if (truncations.length > 0) {
          for (const t of truncations) {
            console.log(`${YELLOW}${t}${RESET}`);
          }
        } else {
          console.log(`  ${GREEN}No truncation detected.${RESET}`);
        }
      }
    } catch (e) {
      error(
        `Failed to build trading context: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  if (inspectType === 'posting' || inspectType === 'both') {
    heading(`Posting Context: ${npcArg}`);
    try {
      const result = await inspectPostingContext(npcArg);

      if (showRaw && result.rawPrompt) {
        console.log(result.rawPrompt);
      } else {
        subheading('Section Breakdown');
        printSectionReport(result.sections);

        subheading('Token Budget');
        console.log(`  Total context tokens: ${result.totalTokens}`);
      }
    } catch (e) {
      error(
        `Failed to build posting context: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // Diff mode
  if (showDiff && inspectType === 'both') {
    heading('Trading vs Posting Comparison');
    try {
      const trading = await inspectTradingContext(npcArg);
      const posting = await inspectPostingContext(npcArg);

      console.log(
        `${''.padEnd(20)}  ${'Trading'.padStart(10)}  ${'Posting'.padStart(10)}`
      );
      console.log('-'.repeat(45));
      console.log(
        `${'Total tokens'.padEnd(20)}  ${String(trading.totalTokens).padStart(10)}  ${String(posting.totalTokens).padStart(10)}`
      );
      console.log(
        `${'Sections'.padEnd(20)}  ${String(trading.sections.length).padStart(10)}  ${String(posting.sections.length).padStart(10)}`
      );
      console.log(
        `${'Populated'.padEnd(20)}  ${String(trading.sections.filter((s) => s.populated).length).padStart(10)}  ${String(posting.sections.filter((s) => s.populated).length).padStart(10)}`
      );
      console.log(
        `${'Ghost vars'.padEnd(20)}  ${String(trading.ghostVars.length).padStart(10)}  ${'N/A'.padStart(10)}`
      );
    } catch (e) {
      error(`Diff failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
