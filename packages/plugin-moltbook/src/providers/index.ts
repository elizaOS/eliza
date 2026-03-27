/**
 * Moltbook Providers
 *
 * Three resolution tiers for task planner context optimization:
 *
 * LOW (moltbookStatusProvider):
 *   ~100 tokens. Auth status, rate limits only.
 *   Use for: "Can I post?" checks.
 *
 * MEDIUM (moltbookContextProvider):
 *   ~300 tokens. Status + hot topics + vibe.
 *   Use for: Deciding whether/what to engage with.
 *
 * HIGH (moltbookFullAnalysisProvider):
 *   ~800 tokens. Full analysis with opportunities.
 *   Use for: Composing posts, strategic decisions.
 */

export {
  // Utilities
  clearAnalysisCache,
  moltbookContextProvider,
  moltbookFullAnalysisProvider,
  // Grouped export
  moltbookProviders,
  // Individual providers
  moltbookStatusProvider,
  refreshCommunityAnalysis,
} from "./context";

// New provider from next branch
export { moltbookStateProvider } from "./moltbookState";
