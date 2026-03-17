/**
 * Directive parsers for extracting inline directives from message text
 */

import type {
  DirectiveExtractResult,
  ElevatedLevel,
  ExecAsk,
  ExecHost,
  ExecSecurity,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "./types";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match a level-based directive (e.g., /think:high)
 */
function matchLevelDirective(
  body: string,
  names: string[],
): { start: number; end: number; rawLevel?: string } | null {
  const namePattern = names.map(escapeRegExp).join("|");
  const match = body.match(
    new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)`, "i"),
  );
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  let end = match.index + match[0].length;
  let i = end;
  while (i < body.length && /\s/.test(body[i])) {
    i += 1;
  }
  if (body[i] === ":") {
    i += 1;
    while (i < body.length && /\s/.test(body[i])) {
      i += 1;
    }
  }
  const argStart = i;
  while (i < body.length && /[A-Za-z0-9-]/.test(body[i])) {
    i += 1;
  }
  const rawLevel = i > argStart ? body.slice(argStart, i) : undefined;
  end = i;
  return { start, end, rawLevel };
}

/**
 * Extract a level-based directive from text
 */
function extractLevelDirective<T>(
  body: string,
  names: string[],
  normalize: (raw?: string) => T | undefined,
): DirectiveExtractResult<T> {
  const match = matchLevelDirective(body, names);
  if (!match) {
    return { cleaned: body.trim(), hasDirective: false };
  }
  const rawLevel = match.rawLevel;
  const level = normalize(rawLevel);
  const cleaned = body
    .slice(0, match.start)
    .concat(" ")
    .concat(body.slice(match.end))
    .replace(/\s+/g, " ")
    .trim();
  return {
    cleaned,
    level,
    rawLevel,
    hasDirective: true,
  };
}

/**
 * Extract a simple directive (no value)
 */
function extractSimpleDirective(
  body: string,
  names: string[],
): { cleaned: string; hasDirective: boolean } {
  const namePattern = names.map(escapeRegExp).join("|");
  const match = body.match(
    new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)(?:\\s*:\\s*)?`, "i"),
  );
  const cleaned = match
    ? body.replace(match[0], " ").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    hasDirective: Boolean(match),
  };
}

// ============================================================================
// Normalizers
// ============================================================================

export function normalizeThinkLevel(
  raw?: string | null,
): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off"].includes(key)) return "off";
  if (["on", "enable", "enabled"].includes(key)) return "low";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key))
    return "low";
  if (
    ["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(
      key,
    )
  )
    return "medium";
  if (
    [
      "high",
      "ultra",
      "ultrathink",
      "think-hard",
      "thinkhardest",
      "highest",
      "max",
    ].includes(key)
  )
    return "high";
  if (["xhigh", "x-high", "x_high"].includes(key)) return "xhigh";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}

export function normalizeVerboseLevel(
  raw?: string | null,
): VerboseLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["full", "all", "everything"].includes(key)) return "full";
  if (["on", "minimal", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

export function normalizeReasoningLevel(
  raw?: string | null,
): ReasoningLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (
    [
      "off",
      "false",
      "no",
      "0",
      "hide",
      "hidden",
      "disable",
      "disabled",
    ].includes(key)
  )
    return "off";
  if (
    ["on", "true", "yes", "1", "show", "visible", "enable", "enabled"].includes(
      key,
    )
  )
    return "on";
  if (["stream", "streaming", "draft", "live"].includes(key)) return "stream";
  return undefined;
}

export function normalizeElevatedLevel(
  raw?: string | null,
): ElevatedLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["full", "auto", "auto-approve", "autoapprove"].includes(key))
    return "full";
  if (["ask", "prompt", "approval", "approve"].includes(key)) return "ask";
  if (["on", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

export function normalizeExecHost(raw?: string | null): ExecHost | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["sandbox", "sb"].includes(key)) return "sandbox";
  if (["gateway", "gw", "local"].includes(key)) return "gateway";
  if (["node", "remote"].includes(key)) return "node";
  return undefined;
}

export function normalizeExecSecurity(
  raw?: string | null,
): ExecSecurity | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["deny", "none", "off"].includes(key)) return "deny";
  if (["allowlist", "allow", "list"].includes(key)) return "allowlist";
  if (["full", "all", "any"].includes(key)) return "full";
  return undefined;
}

export function normalizeExecAsk(raw?: string | null): ExecAsk | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "never", "no"].includes(key)) return "off";
  if (["on-miss", "miss", "fallback"].includes(key)) return "on-miss";
  if (["always", "on", "yes"].includes(key)) return "always";
  return undefined;
}

// ============================================================================
// Directive Extractors
// ============================================================================

export function extractThinkDirective(body?: string): {
  cleaned: string;
  thinkLevel?: ThinkLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const extracted = extractLevelDirective(
    body,
    ["thinking", "think", "t"],
    normalizeThinkLevel,
  );
  return {
    cleaned: extracted.cleaned,
    thinkLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractVerboseDirective(body?: string): {
  cleaned: string;
  verboseLevel?: VerboseLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const extracted = extractLevelDirective(
    body,
    ["verbose", "v"],
    normalizeVerboseLevel,
  );
  return {
    cleaned: extracted.cleaned,
    verboseLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractReasoningDirective(body?: string): {
  cleaned: string;
  reasoningLevel?: ReasoningLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const extracted = extractLevelDirective(
    body,
    ["reasoning", "reason"],
    normalizeReasoningLevel,
  );
  return {
    cleaned: extracted.cleaned,
    reasoningLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractElevatedDirective(body?: string): {
  cleaned: string;
  elevatedLevel?: ElevatedLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const extracted = extractLevelDirective(
    body,
    ["elevated", "elev"],
    normalizeElevatedLevel,
  );
  return {
    cleaned: extracted.cleaned,
    elevatedLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractStatusDirective(body?: string): {
  cleaned: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  return extractSimpleDirective(body, ["status"]);
}

export function extractModelDirective(
  body: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };

  // Match /model:provider/model@profile or /model provider/model@profile
  const modelMatch = body.match(
    /(?:^|\s)\/model(?:\s*:\s*|\s+)([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)?(?:@[a-zA-Z0-9_-]+)?)/i,
  );

  if (modelMatch) {
    const fullMatch = modelMatch[1];
    const atIndex = fullMatch.indexOf("@");
    const rawModel = atIndex >= 0 ? fullMatch.slice(0, atIndex) : fullMatch;
    const rawProfile = atIndex >= 0 ? fullMatch.slice(atIndex + 1) : undefined;
    const cleaned = body
      .replace(modelMatch[0], " ")
      .replace(/\s+/g, " ")
      .trim();
    return { cleaned, rawModel, rawProfile, hasDirective: true };
  }

  // Check for simple /model directive without value
  const simpleMatch = body.match(/(?:^|\s)\/model(?=$|\s|:)/i);
  if (simpleMatch) {
    const cleaned = body
      .replace(simpleMatch[0], " ")
      .replace(/\s+/g, " ")
      .trim();
    return { cleaned, hasDirective: true };
  }

  // Check for model aliases
  if (options?.aliases?.length) {
    for (const alias of options.aliases) {
      const aliasPattern = new RegExp(
        `(?:^|\\s)/${escapeRegExp(alias)}(?=$|\\s)`,
        "i",
      );
      const aliasMatch = body.match(aliasPattern);
      if (aliasMatch) {
        const cleaned = body
          .replace(aliasMatch[0], " ")
          .replace(/\s+/g, " ")
          .trim();
        return { cleaned, rawModel: alias, hasDirective: true };
      }
    }
  }

  return { cleaned: body.trim(), hasDirective: false };
}

export function extractExecDirective(body?: string): {
  cleaned: string;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidHost: boolean;
  invalidSecurity: boolean;
  invalidAsk: boolean;
  invalidNode: boolean;
  hasDirective: boolean;
} {
  if (!body) {
    return {
      cleaned: "",
      hasExecOptions: false,
      invalidHost: false,
      invalidSecurity: false,
      invalidAsk: false,
      invalidNode: false,
      hasDirective: false,
    };
  }

  // Match /exec with optional key=value pairs
  const execMatch = body.match(/(?:^|\s)\/exec(?:\s+([^\/\n]+))?(?=$|\s|\/)/i);
  if (!execMatch) {
    return {
      cleaned: body.trim(),
      hasExecOptions: false,
      invalidHost: false,
      invalidSecurity: false,
      invalidAsk: false,
      invalidNode: false,
      hasDirective: false,
    };
  }

  const args = execMatch[1]?.trim() ?? "";
  const cleaned = body.replace(execMatch[0], " ").replace(/\s+/g, " ").trim();

  let rawExecHost: string | undefined;
  let rawExecSecurity: string | undefined;
  let rawExecAsk: string | undefined;
  let rawExecNode: string | undefined;

  // Parse key=value pairs
  const kvPattern = /(\w+)\s*=\s*([^\s]+)/g;
  let match;
  while ((match = kvPattern.exec(args)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "host") rawExecHost = value;
    else if (key === "security") rawExecSecurity = value;
    else if (key === "ask") rawExecAsk = value;
    else if (key === "node") rawExecNode = value;
  }

  const execHost = normalizeExecHost(rawExecHost);
  const execSecurity = normalizeExecSecurity(rawExecSecurity);
  const execAsk = normalizeExecAsk(rawExecAsk);

  return {
    cleaned,
    execHost,
    execSecurity,
    execAsk,
    execNode: rawExecNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions: Boolean(
      rawExecHost || rawExecSecurity || rawExecAsk || rawExecNode,
    ),
    invalidHost: Boolean(rawExecHost && !execHost),
    invalidSecurity: Boolean(rawExecSecurity && !execSecurity),
    invalidAsk: Boolean(rawExecAsk && !execAsk),
    invalidNode: false, // Node validation is context-dependent
    hasDirective: true,
  };
}
