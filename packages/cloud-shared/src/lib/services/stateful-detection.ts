/**
 * Stateful Detection Service
 *
 * Analyzes user prompts to determine if they require a database.
 * Uses keyword analysis for simple, fast detection without AI overhead.
 */

/**
 * Keywords that indicate the user wants to track/store data.
 * Single keyword matches are weak signals.
 */
const STATEFUL_INDICATORS = [
  // Action words implying persistence
  "track",
  "log",
  "save",
  "store",
  "manage",
  "record",
  "remember",
  "persist",
  "keep",
  "maintain",
  "archive",

  // Collection/data words
  "list",
  "collection",
  "inventory",
  "history",
  "entries",
  "items",
  "records",
  "data",
  "database",
  "storage",

  // App types that typically need persistence
  "tracker",
  "manager",
  "dashboard",
  "crm",
  "journal",
  "diary",
  "planner",
  "organizer",
  "scheduler",
  "calendar",

  // Personal data indicators
  "my",
  "personal",
  "portfolio",
  "library",
  "catalog",
  "bookmarks",
  "favorites",
  "notes",
  "tasks",
  "todos",
  "habits",

  // CRUD operation hints
  "add",
  "delete",
  "edit",
  "update",
  "create",
  "remove",
  "modify",
  "submit",
  "post",
  "upload",
] as const;

/**
 * Phrases that strongly indicate database requirement.
 * Single phrase match is a strong signal.
 */
const STATEFUL_PHRASES = [
  "keep track of",
  "save for later",
  "store data",
  "persist data",
  "save to database",
  "crud",
  "create read update delete",
  "user accounts",
  "sign up",
  "sign in",
  "login system",
  "authentication",
  "user registration",
  "shopping cart",
  "checkout",
  "order history",
  "bookmarked",
  "saved items",
  "favorites list",
  "reading list",
  "watch list",
  "wishlist",
  "todo list",
  "task list",
  "expense tracker",
  "budget tracker",
  "habit tracker",
  "fitness tracker",
  "mood tracker",
  "weight tracker",
  "time tracker",
  "project tracker",
  "bug tracker",
  "issue tracker",
  "inventory management",
  "content management",
  "blog posts",
  "user profiles",
  "member directory",
  "contact list",
  "address book",
  "recipe collection",
  "bookmark manager",
  "password manager",
  "note taking",
  "journal entries",
] as const;

/**
 * Phrases that indicate the app is stateless.
 * Used to avoid false positives.
 */
const STATELESS_INDICATORS = [
  "calculator",
  "converter",
  "generator",
  "static",
  "landing page",
  "portfolio site",
  "brochure",
  "countdown",
  "timer",
  "clock",
  "weather",
  "api proxy",
  "embed",
  "widget",
  "preview",
  "demo",
  "mockup",
  "prototype",
  "wireframe",
  "simple form",
  "contact form",
  "newsletter signup",
  "coming soon",
  "under construction",
  "splash page",
] as const;

export interface DetectionResult {
  /** Whether database is likely required */
  requiresDatabase: boolean;

  /** Confidence level (0-1) */
  confidence: number;

  /** Matched indicators for debugging */
  matchedIndicators: string[];

  /** Matched phrases for debugging */
  matchedPhrases: string[];
}

/**
 * Analyze a user prompt to determine if it requires a database.
 *
 * Detection strategy:
 * 1. Check for explicit database/CRUD phrases (high confidence)
 * 2. Check for stateless indicators (reduces confidence)
 * 3. Count keyword matches (2+ required for implicit detection)
 *
 * @param prompt User's app description/prompt
 * @returns Detection result with confidence score
 */
export function analyzePrompt(prompt: string): DetectionResult {
  const lower = prompt.toLowerCase();
  const matchedIndicators: string[] = [];
  const matchedPhrases: string[] = [];

  // Check for stateless indicators first (early exit)
  for (const indicator of STATELESS_INDICATORS) {
    if (lower.includes(indicator)) {
      return {
        requiresDatabase: false,
        confidence: 0.9,
        matchedIndicators: [],
        matchedPhrases: [],
      };
    }
  }

  // Check for strong phrase matches
  for (const phrase of STATEFUL_PHRASES) {
    if (lower.includes(phrase)) {
      matchedPhrases.push(phrase);
    }
  }

  // Strong phrase match = high confidence
  if (matchedPhrases.length > 0) {
    return {
      requiresDatabase: true,
      confidence: 0.95,
      matchedIndicators: [],
      matchedPhrases,
    };
  }

  // Count keyword matches (word boundary matching)
  for (const indicator of STATEFUL_INDICATORS) {
    const regex = new RegExp(`\\b${indicator}\\b`, "i");
    if (regex.test(lower)) {
      matchedIndicators.push(indicator);
    }
  }

  // Calculate confidence based on keyword count
  const keywordCount = matchedIndicators.length;

  if (keywordCount >= 3) {
    return {
      requiresDatabase: true,
      confidence: 0.85,
      matchedIndicators,
      matchedPhrases,
    };
  }

  if (keywordCount >= 2) {
    return {
      requiresDatabase: true,
      confidence: 0.7,
      matchedIndicators,
      matchedPhrases,
    };
  }

  // Not enough signals
  return {
    requiresDatabase: false,
    confidence: 0.6,
    matchedIndicators,
    matchedPhrases,
  };
}

/**
 * Simple boolean check for whether a prompt requires a database.
 *
 * @param prompt User's app description/prompt
 * @returns true if database is likely required
 */
export function requiresDatabase(prompt: string): boolean {
  return analyzePrompt(prompt).requiresDatabase;
}

/**
 * Get detailed analysis including all matched patterns.
 * Useful for debugging and logging.
 *
 * @param prompt User's app description/prompt
 * @returns Full detection result with all details
 */
export function getDetailedAnalysis(prompt: string): DetectionResult & {
  summary: string;
} {
  const result = analyzePrompt(prompt);

  let summary: string;
  if (result.requiresDatabase) {
    if (result.matchedPhrases.length > 0) {
      summary = `Database required (phrase match: "${result.matchedPhrases[0]}")`;
    } else {
      summary = `Database required (${result.matchedIndicators.length} keyword matches)`;
    }
  } else {
    summary = "No database required";
  }

  return {
    ...result,
    summary,
  };
}
