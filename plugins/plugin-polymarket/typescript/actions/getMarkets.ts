/**
 * @elizaos/plugin-polymarket Unified Market Action
 *
 * Single consolidated action for all market discovery:
 * - Keyword search (e.g., "miami heat", "bitcoin")
 * - Category/tag browsing (e.g., "sports markets", "crypto")
 * - General listing with filters
 * - Sampling modes for market makers
 *
 * Uses Gamma API for better data quality and freshness.
 */

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { GAMMA_API_URL, POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { retrieveAllMarketsTemplate } from "../templates";
import type { MarketsActivityData, SimplifiedMarket } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import {
  callLLMWithTimeout,
  isLLMError,
  sendAcknowledgement,
  sendError,
} from "../utils/llmHelpers";

// =============================================================================
// Type Definitions
// =============================================================================

type SamplingMode = "random" | "rewards";

interface LLMMarketsQuery {
  query?: string; // Keyword search term
  category?: string; // Category/tag filter
  active?: boolean;
  limit?: number;
  next_cursor?: string;
  simplified?: boolean;
  sampling?: boolean;
  sampling_mode?: SamplingMode;
  error?: string;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description?: string;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  endDate: string;
  clobTokenIds?: string;
  volume24hr?: number;
  bestBid?: number;
  bestAsk?: number;
  groupItemTitle?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description?: string;
  active: boolean;
  closed: boolean;
  volume?: number;
  liquidity?: number;
  endDate?: string;
  markets?: GammaMarket[];
  image?: string;
}

interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

interface GammaSearchResponse {
  events: GammaEvent[];
  tags: GammaTag[];
  profiles: Array<{ id: string; name: string }>;
  pagination?: { hasMore: boolean; totalResults: number };
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseOutcomes(outcomesStr: string): string[] {
  try {
    const parsed = JSON.parse(outcomesStr) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseOutcomePrices(pricesStr: string): number[] {
  try {
    const parsed = JSON.parse(pricesStr) as string[];
    return Array.isArray(parsed) ? parsed.map((p) => parseFloat(p)) : [];
  } catch {
    return [];
  }
}

function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

function formatVolume(volume: string | number): string {
  const num = typeof volume === "string" ? parseFloat(volume) : volume;
  if (!Number.isFinite(num) || num === 0) return "";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

/**
 * Filter markets to only include those matching the search term.
 * Used to filter multi-option events (like "2026 NBA Champion") to just the relevant option.
 */
function filterMarketsBySearchTerm(markets: GammaMarket[], searchTerm: string): GammaMarket[] {
  if (!searchTerm || searchTerm.trim().length === 0) return markets;

  const normalized = searchTerm.toLowerCase().trim();
  const searchWords = normalized.split(/\s+/).filter((w) => w.length > 2);

  return markets.filter((market) => {
    const question = (market.question || "").toLowerCase();
    const groupTitle = (market.groupItemTitle || "").toLowerCase();

    // Check if all significant search words appear in the question or group title
    return searchWords.every((word) => question.includes(word) || groupTitle.includes(word));
  });
}

/**
 * Group markets by their parent event to avoid showing 30 teams when user searches for one.
 * Returns a map of eventTitle -> markets[]
 */
function _groupMarketsByEvent(
  markets: Array<GammaMarket & { _eventTitle?: string }>,
): Map<string, GammaMarket[]> {
  const grouped = new Map<string, GammaMarket[]>();

  for (const market of markets) {
    const eventTitle = market._eventTitle || "Other Markets";
    if (!grouped.has(eventTitle)) {
      grouped.set(eventTitle, []);
    }
    grouped.get(eventTitle)?.push(market);
  }

  return grouped;
}

function isKeywordSearch(query: string | undefined, category: string | undefined): boolean {
  // If there's an explicit query, it's a keyword search
  if (query && query.trim().length > 0) return true;

  // If category looks like a search term (multiple words, specific names), treat as search
  if (category) {
    const normalized = category.toLowerCase().trim();
    // Common categories that are browsing, not searching
    const browseCategories = [
      "sports",
      "crypto",
      "politics",
      "entertainment",
      "science",
      "nba",
      "nfl",
      "mlb",
      "nhl",
      "soccer",
      "football",
      "basketball",
      "bitcoin",
      "ethereum",
      "ai",
      "tech",
      "economy",
      "finance",
    ];
    if (browseCategories.includes(normalized)) return false;
    // Multi-word or specific names are likely searches
    if (normalized.includes(" ") || /[A-Z]/.test(category)) return true;
  }

  return false;
}

async function fetchGammaSearch(
  runtime: IAgentRuntime,
  query: string,
  limit: number,
  activeOnly: boolean,
): Promise<{ events: GammaEvent[]; tags: GammaTag[] }> {
  const params = new URLSearchParams({
    q: query,
    limit_per_type: String(Math.min(limit * 2, 25)),
  });
  if (activeOnly) {
    params.append("events_status", "active");
  }

  const url = `${GAMMA_API_URL}/public-search?${params.toString()}`;
  runtime.logger.debug(`[getMarkets] Fetching: ${url}`);

  try {
    const response = await runtime.fetch(url);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      runtime.logger.error(`[getMarkets] Gamma search failed: ${response.status} - ${body}`);
      throw new Error(`Gamma search failed: ${response.status}`);
    }

    const data = (await response.json()) as GammaSearchResponse;
    runtime.logger.debug(`[getMarkets] Search returned ${data.events?.length || 0} events`);
    return { events: data.events || [], tags: data.tags || [] };
  } catch (error) {
    runtime.logger.error(`[getMarkets] Fetch error:`, error);
    throw error;
  }
}

async function fetchGammaEvents(
  runtime: IAgentRuntime,
  options: { tagId?: string; limit: number; activeOnly: boolean },
): Promise<GammaEvent[]> {
  const params = new URLSearchParams({
    closed: "false",
    active: "true",
    limit: String(options.limit),
    order: "volume",
    ascending: "false",
  });

  if (options.tagId) {
    params.append("tag_id", options.tagId);
  }

  const url = `${GAMMA_API_URL}/events?${params.toString()}`;
  const response = await runtime.fetch(url);

  if (!response.ok) {
    throw new Error(`Gamma events failed: ${response.status}`);
  }

  return (await response.json()) as GammaEvent[];
}

async function fetchGammaTags(runtime: IAgentRuntime): Promise<GammaTag[]> {
  try {
    const response = await runtime.fetch(`${GAMMA_API_URL}/tags`);
    if (!response.ok) return [];
    return (await response.json()) as GammaTag[];
  } catch {
    return [];
  }
}

async function findTagByName(
  runtime: IAgentRuntime,
  categoryName: string,
): Promise<GammaTag | null> {
  const tags = await fetchGammaTags(runtime);
  const normalized = categoryName.toLowerCase().trim();

  // Exact match first
  const exact = tags.find((t) => t.label.toLowerCase() === normalized || t.slug === normalized);
  if (exact) return exact;

  // Partial match
  const partial = tags.find(
    (t) => t.label.toLowerCase().includes(normalized) || normalized.includes(t.label.toLowerCase()),
  );
  return partial || null;
}

function filterActiveMarkets(markets: GammaMarket[]): GammaMarket[] {
  const now = Date.now();
  return markets.filter((m) => {
    if (!m.active) return false;
    if (m.closed) return false;
    if (m.archived) return false;
    if (m.endDate) {
      const endDate = new Date(m.endDate).getTime();
      if (!Number.isNaN(endDate) && endDate < now) return false;
    }
    return true;
  });
}

function filterActiveEvents(events: GammaEvent[]): GammaEvent[] {
  const now = Date.now();
  return events.filter((e) => {
    if (!e.active) return false;
    if (e.closed) return false;
    if (e.endDate) {
      const endDate = new Date(e.endDate).getTime();
      if (!Number.isNaN(endDate) && endDate < now) return false;
    }
    return true;
  });
}

function formatMarketResult(market: GammaMarket, index: number, eventTitle?: string): string {
  const statusEmoji = market.active && !market.closed ? "🟢" : "🔴";
  let text = `**${index + 1}. ${market.question}** ${statusEmoji}\n`;

  const outcomes = parseOutcomes(market.outcomes);
  const prices = parseOutcomePrices(market.outcomePrices);

  if (outcomes.length > 0 && prices.length > 0) {
    const priceStr = outcomes
      .map((outcome, i) => `${outcome}: ${formatPrice(prices[i] || 0)}`)
      .join(" | ");
    text += `   📊 ${priceStr}\n`;
  }

  const vol = formatVolume(market.volume);
  if (vol) {
    text += `   💰 Volume: ${vol}`;
    if (market.volume24hr) {
      text += ` (24h: ${formatVolume(market.volume24hr)})`;
    }
    text += `\n`;
  }

  if (eventTitle && eventTitle !== market.question) {
    text += `   📁 Event: ${eventTitle}\n`;
  }

  if (market.endDate) {
    text += `   ⏰ Ends: ${new Date(market.endDate).toLocaleDateString()}\n`;
  }

  // Show token IDs if available (these are what you need for trading)
  if (market.clobTokenIds) {
    try {
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      const outcomes = parseOutcomes(market.outcomes);
      if (tokenIds.length > 0) {
        text += `   🔑 Tokens: `;
        tokenIds.forEach((tid, i) => {
          const outcomeName = outcomes[i] || (i === 0 ? "Yes" : "No");
          text += `${outcomeName}=\`${tid.slice(0, 12)}...\` `;
        });
        text += `\n`;
      }
    } catch {
      // Fallback to condition ID if token parsing fails
      if (market.conditionId) {
        text += `   🔑 ID: \`${market.conditionId.slice(0, 16)}...\`\n`;
      }
    }
  } else if (market.conditionId) {
    text += `   🔑 ID: \`${market.conditionId.slice(0, 16)}...\`\n`;
  }

  return text;
}

function formatEventResult(event: GammaEvent, index: number): string {
  const statusEmoji = event.active && !event.closed ? "🟢" : "🔴";
  let text = `**${index + 1}. ${event.title}** ${statusEmoji}\n`;

  const vol = formatVolume(event.volume || 0);
  if (vol) {
    text += `   💰 Volume: ${vol}\n`;
  }

  if (event.endDate) {
    text += `   ⏰ Ends: ${new Date(event.endDate).toLocaleDateString()}\n`;
  }

  const marketCount = event.markets?.length || 0;
  if (marketCount > 0) {
    text += `   📊 ${marketCount} market(s)\n`;
  }

  return text;
}

// =============================================================================
// Unified Markets Action
// =============================================================================

export const retrieveAllMarketsAction: Action = {
  name: "POLYMARKET_GET_MARKETS",
  similes: [
    "GET_MARKETS",
    "LIST_MARKETS",
    "SHOW_MARKETS",
    "FETCH_MARKETS",
    "POLYMARKET_MARKETS",
    "ALL_MARKETS",
    "BROWSE_MARKETS",
    "VIEW_MARKETS",
    "SEARCH_MARKETS",
    "FIND_MARKETS",
    "SEARCH_POLYMARKET",
    "LOOKUP_MARKETS",
    "QUERY_MARKETS",
    "MARKET_SEARCH",
  ],
  description:
    "Find or browse Polymarket prediction markets. Use for keyword searches ('find miami heat markets'), " +
    "category browsing ('show sports markets'), or general listing. Supports: query (search term), " +
    "category (tag filter), active (boolean), limit (number), simplified (boolean), " +
    "sampling (boolean), sampling_mode (random|rewards).",

  parameters: [
    {
      name: "query",
      description:
        "Search term for specific markets (e.g., 'miami heat', 'bitcoin'). Optional - omit for category browsing or top markets.",
      required: false,
      schema: { type: "string" },
      examples: ["miami heat", "bitcoin", "trump", "super bowl"],
    },
    {
      name: "category",
      description:
        "Category for broad browsing (e.g., 'sports', 'crypto', 'politics'). Only used if query is not provided.",
      required: false,
      schema: { type: "string" },
      examples: ["sports", "crypto", "politics", "entertainment"],
    },
    {
      name: "limit",
      description: "Maximum number of results to return",
      required: false,
      schema: { type: "number" },
      examples: [10, 20, 50],
    },
    {
      name: "active",
      description: "Only show active/open markets",
      required: false,
      schema: { type: "boolean" },
      examples: [true],
    },
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    runtime.logger.info("[getMarkets] Handler started");

    try {
      // Check for direct parameters first (passed via options)
      const params = options?.parameters as Record<string, string | number | boolean> | undefined;

      let query: string | undefined;
      let category: string | undefined;
      let activeOnly = true; // Default to active only
      let limit = 10;
      let simplified = false;
      let sampling = false;
      let samplingMode: SamplingMode | undefined;

      // Priority 1: Direct parameters from options
      if (params) {
        if (typeof params.query === "string" && params.query.trim()) {
          query = params.query.trim();
        }
        if (typeof params.category === "string" && params.category.trim()) {
          category = params.category.trim();
        }
        if (typeof params.active === "boolean") {
          activeOnly = params.active;
        }
        if (typeof params.limit === "number") {
          limit = params.limit;
        }
        if (typeof params.simplified === "boolean") {
          simplified = params.simplified;
        }
        if (typeof params.sampling === "boolean") {
          sampling = params.sampling;
        }
        if (params.sampling_mode === "random" || params.sampling_mode === "rewards") {
          samplingMode = params.sampling_mode;
        }
      }

      // Priority 2: If no direct params, extract using LLM
      if (!query && !category && !sampling) {
        const llmResult = await callLLMWithTimeout<LLMMarketsQuery>(
          runtime,
          state,
          retrieveAllMarketsTemplate,
          "retrieveAllMarketsAction",
        );

        if (llmResult && !isLLMError(llmResult)) {
          query = llmResult.query;
          category = llmResult.category;
          if (llmResult.active !== undefined) activeOnly = llmResult.active;
          if (llmResult.limit) limit = llmResult.limit;
          if (llmResult.simplified !== undefined) simplified = llmResult.simplified;
          if (llmResult.sampling !== undefined) sampling = llmResult.sampling;
          if (llmResult.sampling_mode) samplingMode = llmResult.sampling_mode;
        }
      }

      // Priority 3: Fallback - extract search terms from message text
      if (!query && !category) {
        const messageText = message.content?.text || "";
        const searchPatterns = [
          /search\s+(?:for\s+)?["']?([^"'\n]+?)["']?\s*(?:markets?)?$/i,
          /find\s+(?:markets?\s+)?(?:about\s+|for\s+)?["']?([^"'\n]+?)["']?\s*$/i,
          /markets?\s+(?:about|for|on)\s+["']?([^"'\n]+?)["']?\s*$/i,
          /show\s+(?:me\s+)?["']?([^"'\n]+?)["']?\s+markets?/i,
        ];
        for (const pattern of searchPatterns) {
          const match = messageText.match(pattern);
          if (match?.[1]) {
            const extracted = match[1].trim();
            // Determine if it's a search query or category
            if (isKeywordSearch(extracted, undefined)) {
              query = extracted;
            } else {
              category = extracted;
            }
            break;
          }
        }
      }

      runtime.logger.info(
        `[getMarkets] Resolved params: query=${query}, category=${category}, limit=${limit}`,
      );

      const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;

      // Handle sampling mode (for market makers)
      if (sampling && samplingMode === "rewards") {
        await sendAcknowledgement(callback, "Fetching sampling markets with rewards...", {
          mode: "rewards",
          limit,
        });

        try {
          const clobClient = await initializeClobClient(runtime);
          const response = await clobClient.getSamplingMarkets(undefined);
          const markets = response.data as SimplifiedMarket[];
          const activeMarkets = markets.filter((m) => m.active && !m.closed);
          const limitedMarkets = activeMarkets.slice(0, limit);

          let responseText = `🎯 **Sampling Markets (Rewards Enabled)** (${limitedMarkets.length} results)\n\n`;
          limitedMarkets.forEach((market, index) => {
            responseText += `${index + 1}. Condition: \`${market.condition_id.slice(0, 16)}...\`\n`;
            responseText += `   Min Incentive Size: ${market.min_incentive_size}\n`;
            responseText += `   Max Incentive Spread: ${market.max_incentive_spread}\n\n`;
          });

          const responseContent: Content = {
            text: responseText,
            actions: ["POLYMARKET_GET_MARKETS"],
          };
          if (callback) await callback(responseContent);

          return {
            success: true,
            text: responseText,
            data: { count: String(limitedMarkets.length), mode: "sampling_rewards" },
          };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await sendError(callback, `Failed to fetch sampling markets: ${errMsg}`);
          return { success: false, text: `Sampling markets error: ${errMsg}`, error: errMsg };
        }
      }

      // Determine search mode
      const useKeywordSearch = isKeywordSearch(query, category);
      const searchTerm = query || category || "";

      // Send acknowledgement before API calls
      if (useKeywordSearch && searchTerm) {
        await sendAcknowledgement(callback, `Searching Polymarket for "${searchTerm}"...`, {
          mode: "search",
          activeOnly: activeOnly ? "yes" : "no",
          limit,
        });
      } else if (category) {
        await sendAcknowledgement(callback, `Browsing ${category} markets on Polymarket...`, {
          mode: "browse",
          category,
          limit,
        });
      } else {
        await sendAcknowledgement(callback, "Fetching top markets from Polymarket...", {
          mode: "listing",
          sortBy: "volume",
          limit,
        });
      }

      try {
        runtime.logger.info(
          `[getMarkets] Starting fetch. mode=${useKeywordSearch ? "search" : "browse"}, term=${searchTerm}`,
        );

        let responseText = "";
        let markets: GammaMarket[] = [];
        let events: GammaEvent[] = [];
        let relatedTags: GammaTag[] = [];

        if (useKeywordSearch && searchTerm) {
          // Keyword search using Gamma search API
          runtime.logger.info(`[getMarkets] Calling fetchGammaSearch for: ${searchTerm}`);
          const searchResult = await fetchGammaSearch(runtime, searchTerm, limit, activeOnly);
          runtime.logger.info(
            `[getMarkets] fetchGammaSearch returned ${searchResult.events?.length || 0} events`,
          );
          events = filterActiveEvents(searchResult.events);
          relatedTags = searchResult.tags;

          // Extract markets from events
          const allMarketsFromEvents: Array<GammaMarket & { _eventTitle?: string }> = [];
          for (const event of events) {
            if (event.markets) {
              const filtered = filterActiveMarkets(event.markets);
              allMarketsFromEvents.push(
                ...filtered.map(
                  (m) =>
                    ({ ...m, _eventTitle: event.title }) as GammaMarket & { _eventTitle?: string },
                ),
              );
            }
          }

          // Smart filtering: handle both event-level and market-level searches
          const normalizedSearch = searchTerm.toLowerCase().trim();
          const searchWords = normalizedSearch.split(/\s+/).filter((w) => w.length > 2);

          // Find event that matches most of the search words
          let bestMatchingEvent: GammaEvent | null = null;
          let bestMatchScore = 0;

          for (const event of events) {
            const eventTitle = (event.title || "").toLowerCase();
            const titleWords = eventTitle.split(/\s+/).filter((w) => w.length > 2);
            const matchCount = searchWords.filter((sw) =>
              titleWords.some((tw) => tw.includes(sw) || sw.includes(tw)),
            ).length;
            if (matchCount > bestMatchScore) {
              bestMatchScore = matchCount;
              bestMatchingEvent = event;
            }
          }

          let matchingMarkets: Array<GammaMarket & { _eventTitle?: string }> = [];

          // If we found a matching event, search within its markets
          if (bestMatchingEvent?.markets && bestMatchingEvent.markets.length > 0) {
            const eventMarkets = filterActiveMarkets(bestMatchingEvent.markets);
            const eventMarketsWithTitle = eventMarkets.map(
              (m) =>
                ({
                  ...m,
                  _eventTitle: bestMatchingEvent?.title,
                }) as GammaMarket & { _eventTitle?: string },
            );

            // Find words in search that AREN'T in the event title (these are market-specific)
            const eventTitle = (bestMatchingEvent.title || "").toLowerCase();
            const eventTitleWords = eventTitle.split(/\s+/).filter((w) => w.length > 2);
            const marketSpecificWords = searchWords.filter(
              (sw) => !eventTitleWords.some((tw) => tw.includes(sw) || sw.includes(tw)),
            );

            runtime.logger.info(
              `[getMarkets] Event "${bestMatchingEvent.title}" matches. Market-specific words: [${marketSpecificWords.join(", ")}]`,
            );

            if (marketSpecificWords.length > 0) {
              // Filter to markets matching the market-specific words
              matchingMarkets = eventMarketsWithTitle.filter((m) => {
                const question = (m.question || "").toLowerCase();
                const groupTitle = (m.groupItemTitle || "").toLowerCase();
                return marketSpecificWords.some(
                  (word) => question.includes(word) || groupTitle.includes(word),
                );
              });
              runtime.logger.info(
                `[getMarkets] Filtered to ${matchingMarkets.length} markets matching market-specific words`,
              );
            } else {
              // No market-specific words - show all from this event
              matchingMarkets = eventMarketsWithTitle;
              runtime.logger.info(
                `[getMarkets] No market-specific words, showing all ${matchingMarkets.length} markets from event`,
              );
            }
          }

          // Fallback: filter all markets if no event match
          if (matchingMarkets.length === 0) {
            matchingMarkets = filterMarketsBySearchTerm(allMarketsFromEvents, searchTerm);
            runtime.logger.info(
              `[getMarkets] Fallback: filtered ${allMarketsFromEvents.length} markets down to ${matchingMarkets.length}`,
            );
          }

          // If filtering removed all results, show a few from the events for context
          if (matchingMarkets.length === 0 && allMarketsFromEvents.length > 0) {
            // Show the event-level info instead of individual markets
            responseText = `🔍 **Search Results for "${searchTerm}"**\n\n`;
            responseText += `Found ${events.length} related event(s), but no exact market match for "${searchTerm}".\n\n`;

            events.slice(0, limit).forEach((event, index) => {
              responseText += `${formatEventResult(event, index)}\n`;
            });

            if (relatedTags.length > 0) {
              responseText += `\n🏷️ Related tags: ${relatedTags
                .slice(0, 5)
                .map((t) => t.label)
                .join(", ")}\n`;
            }

            const responseContent: Content = {
              text: responseText,
              actions: ["POLYMARKET_GET_MARKETS"],
            };
            if (callback) await callback(responseContent);
            return {
              success: true,
              text: responseText,
              data: { mode: "search", query: searchTerm, count: String(events.length) },
            };
          }

          markets = matchingMarkets;

          responseText = `🔍 **Search Results for "${searchTerm}"**\n\n`;

          if (markets.length === 0 && events.length === 0) {
            responseText += `No markets found matching "${searchTerm}".\n\n`;
            responseText += `💡 *Try different keywords or check the spelling.*\n`;

            if (relatedTags.length > 0) {
              responseText += `\n🏷️ Related tags: ${relatedTags
                .slice(0, 5)
                .map((t) => t.label)
                .join(", ")}\n`;
            }
          } else if (markets.length > 0) {
            responseText += `Found ${markets.length} market(s):\n\n`;
            const limited = markets.slice(0, limit);
            limited.forEach((market, index) => {
              const eventTitle = (market as GammaMarket & { _eventTitle?: string })._eventTitle;
              responseText += `${formatMarketResult(market, index, eventTitle)}\n`;
            });
          } else {
            // Show events if no individual markets
            responseText += `Found ${events.length} event(s):\n\n`;
            events.slice(0, limit).forEach((event, index) => {
              responseText += `${formatEventResult(event, index)}\n`;
            });
          }
        } else {
          // Category browsing or general listing using Gamma events API
          let tagId: string | undefined;
          if (category) {
            const tag = await findTagByName(runtime, category);
            if (tag) {
              tagId = tag.id;
            }
          }

          events = await fetchGammaEvents(runtime, { tagId, limit: limit * 2, activeOnly });
          events = filterActiveEvents(events);

          // Extract markets from events
          for (const event of events) {
            if (event.markets) {
              const filtered = filterActiveMarkets(event.markets);
              markets.push(...filtered);
            }
          }

          if (category && tagId) {
            responseText = `📊 **${category.charAt(0).toUpperCase() + category.slice(1)} Markets**\n\n`;
          } else if (category) {
            // Tag not found, try search instead
            const searchResult = await fetchGammaSearch(runtime, category, limit, activeOnly);
            events = filterActiveEvents(searchResult.events);
            markets = [];
            for (const event of events) {
              if (event.markets) {
                markets.push(...filterActiveMarkets(event.markets));
              }
            }
            responseText = `🔍 **Markets matching "${category}"**\n\n`;
          } else {
            responseText = `📊 **Active Polymarket Markets** (Top by Volume)\n\n`;
          }

          if (events.length === 0 && markets.length === 0) {
            responseText += "No active markets found.\n";

            // Suggest available tags
            const allTags = await fetchGammaTags(runtime);
            if (allTags.length > 0) {
              responseText += `\n🏷️ Available categories: ${allTags
                .slice(0, 10)
                .map((t) => t.label)
                .join(", ")}\n`;
            }
          } else if (simplified || markets.length === 0) {
            // Show events in simplified view
            events.slice(0, limit).forEach((event, index) => {
              responseText += `${formatEventResult(event, index)}\n`;
            });
          } else {
            // Show individual markets
            markets.slice(0, limit).forEach((market, index) => {
              responseText += `${formatMarketResult(market, index)}\n`;
            });
          }
        }

        if (relatedTags.length > 0 && !responseText.includes("Related tags")) {
          responseText += `\n🏷️ Related tags: ${relatedTags
            .slice(0, 5)
            .map((t) => t.label)
            .join(", ")}\n`;
        }

        runtime.logger.info(
          `[getMarkets] Response built, length=${responseText.length}, calling callback`,
        );
        const responseContent: Content = {
          text: responseText,
          actions: ["POLYMARKET_GET_MARKETS"],
        };
        if (callback) {
          await callback(responseContent);
          runtime.logger.info(`[getMarkets] Callback completed successfully`);
        } else {
          runtime.logger.warn(`[getMarkets] No callback provided!`);
        }

        // Record activity
        if (service && markets.length > 0) {
          const activityData: MarketsActivityData = {
            type: "markets_list",
            mode: useKeywordSearch ? "search" : "browse",
            count: markets.length,
            tags: relatedTags.map((t) => t.label),
            markets: markets.slice(0, 10).map((m) => ({
              conditionId: m.conditionId || m.id,
              question: m.question,
              active: m.active ?? false,
              closed: m.closed ?? false,
            })),
          };
          await service.recordActivity(activityData);
        }

        return {
          success: true,
          text: responseText,
          data: {
            mode: useKeywordSearch ? "search" : "browse",
            query: searchTerm || undefined,
            count: String(markets.length || events.length),
            timestamp: new Date().toISOString(),
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        runtime.logger.error("[getMarkets] Inner error:", error);
        await sendError(
          callback,
          `Failed to fetch markets: ${errorMessage}`,
          searchTerm || "general listing",
        );
        return { success: false, text: `Markets error: ${errorMessage}`, error: errorMessage };
      }
    } catch (outerError) {
      // Catch-all for any unexpected errors
      const errorMessage = outerError instanceof Error ? outerError.message : String(outerError);
      runtime.logger.error("[getMarkets] Outer error:", outerError);
      await sendError(callback, `Unexpected error: ${errorMessage}`);
      return { success: false, text: `Unexpected error: ${errorMessage}`, error: errorMessage };
    }
  },

  examples: [
    // Example 1: Specific search query - uses query parameter
    [
      { name: "{{user1}}", content: { text: "Find miami heat markets" } },
      {
        name: "{{user2}}",
        content: {
          text: "Searching for Miami Heat prediction markets.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    // Example 2: Category browsing - uses category parameter
    [
      { name: "{{user1}}", content: { text: "Show me all the sports markets" } },
      {
        name: "{{user2}}",
        content: {
          text: "Browsing sports markets on Polymarket.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    // Example 3: Multi-turn - user refines search
    [
      { name: "{{user1}}", content: { text: "What prediction markets are available?" } },
      {
        name: "{{user2}}",
        content: {
          text: "I can search for specific topics or browse categories. What are you interested in - crypto, sports, politics, or something specific?",
        },
      },
      { name: "{{user1}}", content: { text: "Show me anything about bitcoin" } },
      {
        name: "{{user2}}",
        content: {
          text: "Searching for Bitcoin-related prediction markets.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    // Example 4: User wants token details - should NOT use this action
    [
      { name: "{{user1}}", content: { text: "Tell me about token 0x123abc" } },
      {
        name: "{{user2}}",
        content: {
          text: "Let me get the details for that specific token.",
          action: "POLYMARKET_GET_TOKEN_INFO",
        },
      },
    ],
    // Example 5: General market listing
    [
      { name: "{{user1}}", content: { text: "What are the hottest markets right now?" } },
      {
        name: "{{user2}}",
        content: { text: "Fetching top markets by volume.", action: "POLYMARKET_GET_MARKETS" },
      },
    ],
    // Example 6: User wants to trade - should NOT search
    [
      { name: "{{user1}}", content: { text: "Buy 50 shares of the Trump market at 40 cents" } },
      {
        name: "{{user2}}",
        content: { text: "I'll place that order for you.", action: "POLYMARKET_PLACE_ORDER" },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Show reward sampling markets" } },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching markets with liquidity rewards enabled.",
          action: "POLYMARKET_GET_MARKETS",
          parameters: { sampling: true, sampling_mode: "rewards" },
        },
      },
    ],
  ],
};
