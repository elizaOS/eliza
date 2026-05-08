#!/usr/bin/env tsx
import { buildActionCatalog, normalizeActionName, type RuntimeActionLike } from "../packages/core/src/runtime/action-catalog.ts";
import { retrieveActions, type ActionRetrievalResult } from "../packages/core/src/runtime/action-retrieval.ts";
import { tierActionResults, type TieredActionSurface } from "../packages/core/src/runtime/action-tiering.ts";

type Args = Record<string, string>;
type BenchmarkCase = {
  id: string;
  scenario: "exact" | "candidate" | "prose" | "vague";
  messageText: string;
  expectedParent: string;
  candidateActions?: string[];
  parentActionHints?: string[];
};

type CaseResult = BenchmarkCase & {
  top1?: string;
  top3: string[];
  rank: number | null;
  score: number;
  tier: "tierA" | "tierB" | "tierC";
  exposedActions: number;
  fullCatalogTokens: number;
  exposedTokens: number;
  utilizedTokens: number;
  wastedTokens: number;
  tokenSavings: number;
  tokenUtilization: number;
};

const DOMAIN_TEMPLATES = [
  ["MUSIC", "playback songs playlists speakers audio albums artists"],
  ["CALENDAR", "meetings events schedules reminders attendees dates time"],
  ["EMAIL", "mail inbox drafts recipients subject attachments"],
  ["TASKS", "todo projects deadlines assignments checklists status"],
  ["FILES", "documents folders upload download search rename organize"],
  ["BROWSER", "web pages tabs forms navigation scraping clicking"],
  ["SEARCH", "research query web sources citations summaries"],
  ["IMAGE", "pictures generation editing crop style visual"],
  ["MEMORY", "facts preferences relationships recall notes history"],
  ["WALLET", "balances transfers tokens chains signing payments"],
  ["TRADING", "orders positions prices swaps portfolio markets"],
  ["SOCIAL", "posts replies mentions followers timeline messages"],
  ["DOCS", "writing markdown document edit outline review"],
  ["SHEETS", "spreadsheet rows columns formulas charts tables"],
  ["SLIDES", "presentation deck slides speaker notes layout"],
  ["CONTACTS", "people address book phone relationship lookup"],
  ["MAPS", "routes places directions distance travel location"],
  ["SHOPPING", "products cart price compare purchase order"],
  ["HEALTH", "workout nutrition sleep symptoms goals tracking"],
  ["HOME", "lights thermostat locks appliances sensors rooms"],
] as const;

const CHILD_VERBS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "SEARCH",
  "SEND",
  "READ",
  "PLAY",
  "PAUSE",
  "SUMMARIZE",
  "EXPORT",
  "IMPORT",
  "ANALYZE",
];

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...value] = arg.slice(2).split("=");
    args[key] = value.length > 0 ? value.join("=") : "true";
  }
  return args;
}

function approxTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function actionText(action: RuntimeActionLike): string {
  return [
    action.name,
    action.description,
    action.descriptionCompressed,
    action.compressedDescription,
    ...(action.similes ?? []),
    ...(action.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function actionTokens(action: RuntimeActionLike): number {
  return approxTokens(actionText(action));
}

function buildSyntheticCatalog(parentCount: number, childrenPerParent: number) {
  const actions: RuntimeActionLike[] = [];
  const cases: BenchmarkCase[] = [];

  for (let index = 0; index < parentCount; index += 1) {
    const [domain, keywords] = DOMAIN_TEMPLATES[index % DOMAIN_TEMPLATES.length];
    const family = Math.floor(index / DOMAIN_TEMPLATES.length).toString().padStart(2, "0");
    const parentName = `${domain}_${family}`;
    const unique = `${domain.toLowerCase()} capability ${family}`;
    const childNames: string[] = [];

    for (let childIndex = 0; childIndex < childrenPerParent; childIndex += 1) {
      const verb = CHILD_VERBS[(index + childIndex) % CHILD_VERBS.length];
      const childName = `${parentName}_${verb}`;
      childNames.push(childName);
      actions.push({
        name: childName,
        description: `${verb.toLowerCase()} ${unique}; handles ${keywords}.`,
        descriptionCompressed: `${verb.toLowerCase()} ${domain.toLowerCase()} ${family}`,
        similes: [`${verb.toLowerCase()} ${domain.toLowerCase()}`, `${unique} ${verb.toLowerCase()}`],
        tags: [domain.toLowerCase(), verb.toLowerCase(), `family-${family}`],
      });
    }

    actions.push({
      name: parentName,
      description: `Parent action for ${unique}; routes requests about ${keywords}.`,
      descriptionCompressed: `${domain.toLowerCase()} ${family} parent`,
      similes: [`${domain.toLowerCase()} tools`, unique],
      tags: [domain.toLowerCase(), `family-${family}`],
      subActions: childNames,
      cacheStable: true,
      cacheScope: "agent",
    });

    const targetChild = childNames[0];
    const targetVerb = targetChild.split("_").at(-1)?.toLowerCase() ?? "use";
    cases.push(
      {
        id: `${parentName}:exact`,
        scenario: "exact",
        messageText: `please handle ${unique}`,
        expectedParent: parentName,
        parentActionHints: [parentName],
      },
      {
        id: `${parentName}:candidate`,
        scenario: "candidate",
        messageText: `please ${targetVerb} this ${domain.toLowerCase()} request`,
        expectedParent: parentName,
        candidateActions: [targetChild],
      },
      {
        id: `${parentName}:prose`,
        scenario: "prose",
        messageText: `please ${targetVerb} using ${unique}; the request is about ${keywords}`,
        expectedParent: parentName,
      },
      {
        id: `${parentName}:vague`,
        scenario: "vague",
        messageText: `please ${targetVerb} something for ${domain.toLowerCase()}`,
        expectedParent: parentName,
      },
    );
  }

  return { actions, cases };
}

function fullCatalogTokens(actions: RuntimeActionLike[]): number {
  return actions.reduce((sum, action) => sum + actionTokens(action), 0);
}

function surfaceTokens(surface: TieredActionSurface, actionByName: Map<string, RuntimeActionLike>): number {
  return approxTokens(surface.protocolActions.join(" ")) + surface.exposedActionNames.reduce((sum, name) => {
    const action = actionByName.get(normalizeActionName(name));
    return sum + (action ? actionTokens(action) : approxTokens(name));
  }, 0);
}

function expectedUsefulTokens(
  expectedParent: string,
  tier: CaseResult["tier"],
  actionByName: Map<string, RuntimeActionLike>,
  childNamesByParent: Map<string, string[]>,
): number {
  if (tier === "tierC") return 0;
  const parent = actionByName.get(normalizeActionName(expectedParent));
  const parentTokens = parent ? actionTokens(parent) : approxTokens(expectedParent);
  if (tier === "tierB") return parentTokens;
  return parentTokens + (childNamesByParent.get(normalizeActionName(expectedParent)) ?? []).reduce((sum, child) => {
    const action = actionByName.get(normalizeActionName(child));
    return sum + (action ? actionTokens(action) : approxTokens(child));
  }, 0);
}

function resultTier(surface: TieredActionSurface, expectedParent: string): CaseResult["tier"] {
  const normalized = normalizeActionName(expectedParent);
  if (surface.tierAParents.some((parent) => parent.normalizedName === normalized)) return "tierA";
  if (surface.tierBParents.some((parent) => parent.normalizedName === normalized)) return "tierB";
  return "tierC";
}

function evaluateCase(
  testCase: BenchmarkCase,
  catalog: ReturnType<typeof buildActionCatalog>,
  actions: RuntimeActionLike[],
  actionByName: Map<string, RuntimeActionLike>,
  childNamesByParent: Map<string, string[]>,
): CaseResult {
  const retrieval = retrieveActions({
    catalog,
    messageText: testCase.messageText,
    candidateActions: testCase.candidateActions,
    parentActionHints: testCase.parentActionHints,
  });
  const surface = tierActionResults({ catalog, results: retrieval.results });
  const expectedNormalized = normalizeActionName(testCase.expectedParent);
  const expectedResult = retrieval.results.find((result) => result.normalizedName === expectedNormalized);
  const tier = resultTier(surface, testCase.expectedParent);
  const fullTokens = fullCatalogTokens(actions);
  const exposedTokens = surfaceTokens(surface, actionByName);
  const utilizedTokens = expectedUsefulTokens(testCase.expectedParent, tier, actionByName, childNamesByParent);

  return {
    ...testCase,
    top1: retrieval.results[0]?.name,
    top3: retrieval.results.slice(0, 3).map((result: ActionRetrievalResult) => result.name),
    rank: expectedResult?.rank ?? null,
    score: expectedResult?.score ?? 0,
    tier,
    exposedActions: surface.exposedActionNames.length,
    fullCatalogTokens: fullTokens,
    exposedTokens,
    utilizedTokens,
    wastedTokens: Math.max(0, exposedTokens - utilizedTokens),
    tokenSavings: fullTokens > 0 ? 1 - exposedTokens / fullTokens : 0,
    tokenUtilization: exposedTokens > 0 ? utilizedTokens / exposedTokens : 0,
  };
}

function summarizeResults(results: CaseResult[]) {
  const groups = new Map<string, CaseResult[]>();
  for (const result of results) {
    const bucket = groups.get(result.scenario) ?? [];
    bucket.push(result);
    groups.set(result.scenario, bucket);
  }

  const summarizeGroup = (items: CaseResult[]) => ({
    cases: items.length,
    top1: ratio(items.filter((item) => item.rank === 1).length, items.length),
    top3: ratio(items.filter((item) => item.rank !== null && item.rank <= 3).length, items.length),
    exposed: ratio(items.filter((item) => item.tier !== "tierC").length, items.length),
    tierA: ratio(items.filter((item) => item.tier === "tierA").length, items.length),
    tierB: ratio(items.filter((item) => item.tier === "tierB").length, items.length),
    avgExposedActions: average(items.map((item) => item.exposedActions)),
    avgFullCatalogTokens: average(items.map((item) => item.fullCatalogTokens)),
    avgExposedTokens: average(items.map((item) => item.exposedTokens)),
    avgTokenSavings: average(items.map((item) => item.tokenSavings)),
    avgTokenUtilization: average(items.map((item) => item.tokenUtilization)),
  });

  return {
    overall: summarizeGroup(results),
    byScenario: Object.fromEntries([...groups.entries()].map(([key, value]) => [key, summarizeGroup(value)])),
    misses: results
      .filter((item) => item.rank !== 1 || item.tier === "tierC")
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        scenario: item.scenario,
        expectedParent: item.expectedParent,
        top1: item.top1,
        top3: item.top3,
        rank: item.rank,
        tier: item.tier,
        score: round(item.score),
      })),
  };
}

function ratio(count: number, total: number): number {
  return total > 0 ? round(count / total) : 0;
}

function average(values: number[]): number {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function printMarkdown(summary: ReturnType<typeof summarizeResults>, metadata: Record<string, unknown>) {
  console.log(`# Action retrieval benchmark`);
  console.log(``);
  console.log(`- parents: ${metadata.parents}`);
  console.log(`- children per parent: ${metadata.childrenPerParent}`);
  console.log(`- total actions: ${metadata.totalActions}`);
  console.log(`- cases: ${metadata.cases}`);
  console.log(``);
  console.log(`| Scenario | Top1 | Top3 | Exposed | Tier A | Tier B | Avg exposed actions | Avg token savings | Avg token utilization |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [scenario, stats] of Object.entries(summary.byScenario)) {
    console.log(`| ${scenario} | ${pct(stats.top1)} | ${pct(stats.top3)} | ${pct(stats.exposed)} | ${pct(stats.tierA)} | ${pct(stats.tierB)} | ${stats.avgExposedActions} | ${pct(stats.avgTokenSavings)} | ${pct(stats.avgTokenUtilization)} |`);
  }
  console.log(`| overall | ${pct(summary.overall.top1)} | ${pct(summary.overall.top3)} | ${pct(summary.overall.exposed)} | ${pct(summary.overall.tierA)} | ${pct(summary.overall.tierB)} | ${summary.overall.avgExposedActions} | ${pct(summary.overall.avgTokenSavings)} | ${pct(summary.overall.avgTokenUtilization)} |`);
  if (summary.misses.length > 0) {
    console.log(``);
    console.log(`## Worst misses`);
    for (const miss of summary.misses.slice(0, 10)) {
      console.log(`- ${miss.id}: expected ${miss.expectedParent}, top1 ${miss.top1}, rank ${miss.rank ?? "none"}, tier ${miss.tier}, score ${miss.score}`);
    }
  }
}

function pct(value: number): string {
  return `${round(value * 100)}%`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const parentCount = Math.max(1, Number(args.parents ?? 100));
  const childrenPerParent = Math.max(1, Number(args.children ?? 4));
  const { actions, cases } = buildSyntheticCatalog(parentCount, childrenPerParent);
  const catalog = buildActionCatalog(actions);
  const actionByName = new Map(actions.map((action) => [normalizeActionName(action.name), action]));
  const childNamesByParent = new Map(catalog.parents.map((parent) => [parent.normalizedName, parent.childNames]));
  const results = cases.map((testCase) => evaluateCase(testCase, catalog, actions, actionByName, childNamesByParent));
  const summary = summarizeResults(results);
  const metadata = {
    parents: parentCount,
    childrenPerParent,
    totalActions: actions.length,
    cases: cases.length,
    warnings: catalog.warnings.length,
  };

  if (args.format === "json") {
    console.log(JSON.stringify({ metadata, summary, results }, null, 2));
    return;
  }
  printMarkdown(summary, metadata);
}

main();
