import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type Action,
  type ActionResult,
  CANONICAL_SUBACTION_KEY,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import {
  failureToActionResult,
  readNumberParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
  truncate,
} from "../lib/format.js";
import { runShell, type ShellResult } from "../lib/run-shell.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const STREAM_CAP_CHARS = 30_000;
const SHELL_HISTORY_DEFAULT_LIMIT = 20;
const URL_PREFIXES = ["https://", "http://"] as const;
const SHELL_URL_METACHARS = new Set(["&", ";", "(", ")", "<", ">", "|"]);
const COINGECKO_SIMPLE_PRICE_BASE =
  "https://api.coingecko.com/api/v3/simple/price";

type ShellActionSubaction = "run" | "clear_history" | "view_history";

interface CryptoSpotAsset {
  symbol: string;
  coingeckoId: string;
  terms: RegExp;
}

interface CryptoSpotCommandResolution {
  command: string;
  asset?: CryptoSpotAsset;
  rewritten: boolean;
}

interface DiskInspectionCommandResolution {
  command: string;
  rewritten: boolean;
}

type LocalStatusKind = "health" | "memory";

interface LocalStatusCommandResolution {
  command: string;
  kind?: LocalStatusKind;
  rewritten: boolean;
}

interface SourceInspectionCommandResolution {
  command: string;
  rewritten: boolean;
}

type ShellHistoryEntryLike = {
  command?: unknown;
};

type ShellHistoryServiceLike = {
  clearCommandHistory?: (conversationId: string) => void;
  getCommandHistory?: (
    conversationId: string,
    limit?: number,
  ) => ShellHistoryEntryLike[];
};

const CRYPTO_SPOT_ASSETS: CryptoSpotAsset[] = [
  {
    symbol: "BTC",
    coingeckoId: "bitcoin",
    terms: /\b(?:btc|bitcoin)\b/iu,
  },
  {
    symbol: "ETH",
    coingeckoId: "ethereum",
    terms: /\b(?:eth|ethereum)\b/iu,
  },
  {
    symbol: "SOL",
    coingeckoId: "solana",
    terms: /\b(?:sol|solana)\b/iu,
  },
];

const BOUNDED_DISK_INSPECTION_COMMAND =
  'df -h / /home; printf \'\\n--- cleanup candidates ---\\n\'; for p in /tmp /var/tmp "$HOME/.cache" "$HOME/.bun" "$HOME/.npm" "$HOME/.local/share/Trash"; do [ -e "$p" ] && du -sh "$p" 2>/dev/null; done | sort -hr | head -n 10';
const LOCAL_HEALTH_COMMAND = `PORT="\${ELIZA_API_PORT:-\${ELIZA_PORT:-\${API_PORT:-\${SERVER_PORT:-2138}}}}"; curl -fsS "http://127.0.0.1:\${PORT}/api/health"`;
const LOCAL_MEMORY_COMMAND = "free -m";
const SOURCE_SEARCH_EXCLUDES = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/.turbo/**",
  "!**/.cache/**",
  "!**/coverage/**",
  "!**/.next/**",
] as const;

function normalizeShellSubaction(
  value: string | undefined,
): ShellActionSubaction {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "clear":
    case "clear_history":
    case "history_clear":
      return "clear_history";
    case "view":
    case "show":
    case "list":
    case "view_history":
    case "show_history":
    case "list_history":
    case "history_view":
      return "view_history";
    default:
      return "run";
  }
}

function inferShellSubactionFromText(
  text: string,
): ShellActionSubaction | null {
  const lower = text.toLowerCase();
  if (!/\b(history|terminal|shell|command)\b/.test(lower)) return null;
  if (/\b(show|view|list|display|print)\b/.test(lower)) return "view_history";
  if (/\b(clear|reset|delete|remove|clean|wipe)\b/.test(lower)) {
    return "clear_history";
  }
  return null;
}

function getShellHistoryService(
  runtime: IAgentRuntime,
): ShellHistoryServiceLike | null {
  const service = runtime.getService("shell") as unknown;
  return service && typeof service === "object" ? service : null;
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Math.floor(value)));
}

function clampHistoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return SHELL_HISTORY_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function textMentionsPath(text: string, requestedPath: string): boolean {
  const normalizedText = text.replace(/\\/g, "/");
  const normalizedPath = requestedPath.replace(/\\/g, "/");
  return normalizedText.includes(normalizedPath);
}

function asksAboutRunningRuntimeSource(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const mentionsRepoState =
    /\b(?:branch|commit|head|revision|sha|cwd|directory|folder|path|repo|repository|source|submodule|worktree)\b/.test(
      normalized,
    );
  const groundsToLocalRuntime =
    /\b(?:running|runtime|process|service|bot|agent|currently|current|local|workspace|worktree|vendored|vendor|present)\b/.test(
      normalized,
    ) || /\bchecked[- ]out\b/.test(normalized);
  return mentionsRepoState && groundsToLocalRuntime;
}

function requestedCryptoSpotAsset(text: string): CryptoSpotAsset | undefined {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (
    !/\b(?:price|spot|quote|rate|trading|worth|usd|dollars?)\b/iu.test(
      normalized,
    )
  ) {
    return undefined;
  }
  return CRYPTO_SPOT_ASSETS.find((asset) => asset.terms.test(normalized));
}

function coingeckoSimplePriceCommand(asset: CryptoSpotAsset): string {
  const url = `${COINGECKO_SIMPLE_PRICE_BASE}?ids=${encodeURIComponent(
    asset.coingeckoId,
  )}&vs_currencies=usd`;
  return `curl -fsS ${shellSingleQuote(url)}`;
}

function usesUnreliableCryptoSpotEndpoint(
  command: string,
  asset: CryptoSpotAsset,
): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("api.coindesk.com/v1/bpi/currentprice")) {
    return asset.symbol === "BTC";
  }
  if (!lower.includes("api.binance.com/api/v3/ticker/price")) {
    return false;
  }
  const symbolParam = `${asset.symbol.toLowerCase()}usdt`;
  return lower.includes(`symbol=${symbolParam}`);
}

export function resolveCryptoSpotPriceCommand(args: {
  command: string;
  messageText: string;
}): CryptoSpotCommandResolution {
  const asset = requestedCryptoSpotAsset(args.messageText);
  if (!asset) return { command: args.command, rewritten: false };
  if (!usesUnreliableCryptoSpotEndpoint(args.command, asset)) {
    return { command: args.command, asset, rewritten: false };
  }
  return {
    command: coingeckoSimplePriceCommand(asset),
    asset,
    rewritten: true,
  };
}

function asksForDiskInspection(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /\b(?:disk|storage|filesystem|free space|cleanup|clean up|space)\b/.test(
    normalized,
  );
}

function usesBroadDiskUsageScan(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!/\bdu\b/.test(normalized)) return false;
  return (
    /\bdu\b[^;&|]*(?:\/\*|\/home\/\*)/.test(normalized) ||
    /\bdu\b[^;&|]*\s\/(?:\s|$)/.test(normalized)
  );
}

export function resolveDiskInspectionCommand(args: {
  command: string;
  messageText: string;
}): DiskInspectionCommandResolution {
  if (!asksForDiskInspection(args.messageText)) {
    return { command: args.command, rewritten: false };
  }
  if (!usesBroadDiskUsageScan(args.command)) {
    return { command: args.command, rewritten: false };
  }
  return { command: BOUNDED_DISK_INSPECTION_COMMAND, rewritten: true };
}

function requestedLocalStatusKind(text: string): LocalStatusKind | undefined {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (
    /\b(?:health endpoint|api\/health|ready status|plugin counts?|bot health|runtime health)\b/.test(
      normalized,
    ) &&
    /\b(?:local|bot|runtime|ready|plugins?)\b/.test(normalized)
  ) {
    return "health";
  }
  if (
    /\b(?:ram|memory)\b/.test(normalized) &&
    /\b(?:free|available|right now|current|currently)\b/.test(normalized)
  ) {
    return "memory";
  }
  return undefined;
}

export function resolveLocalStatusCommand(args: {
  command: string;
  messageText: string;
}): LocalStatusCommandResolution {
  const kind = requestedLocalStatusKind(args.messageText);
  if (kind === "health") {
    return {
      command: LOCAL_HEALTH_COMMAND,
      kind,
      rewritten: args.command !== LOCAL_HEALTH_COMMAND,
    };
  }
  if (kind === "memory") {
    return {
      command: LOCAL_MEMORY_COMMAND,
      kind,
      rewritten: args.command !== LOCAL_MEMORY_COMMAND,
    };
  }
  return { command: args.command, rewritten: false };
}

function asksForLocalSourceInspection(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /\b(?:does|do|is|are|can|could|check|verify|inspect|show)\b[\s\S]{0,160}\b(?:local|vendored|workspace|worktree|repo|repository|submodules?|source|code)\b[\s\S]{0,160}\b(?:include|contain|have|support|implement|detect|use)\b/.test(
      normalized,
    ) &&
    /\b(?:local|vendored|workspace|worktree|repo|repository|submodules?)\b/.test(
      normalized,
    )
  );
}

function broadRecursiveGrepPattern(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, " ");
  if (!/\bgrep\b[^;&|]*-(?:[^\s-]*r|[^\s-]*R)\b/i.test(normalized)) {
    return undefined;
  }
  if (
    !/(?:^|\s)(?:\/|\/home(?:\/[^\s;&|]+)?)(?:\s|$|[;&|])/u.test(normalized)
  ) {
    return undefined;
  }
  const quoted = command.match(/\bgrep\b[\s\S]*?(?:"([^"]+)"|'([^']+)')/u);
  const pattern = quoted?.[1] ?? quoted?.[2];
  return pattern?.trim() || undefined;
}

function boundedSourceSearchCommand(pattern: string): string {
  const quotedPattern = shellSingleQuote(pattern);
  const gitExcludes = SOURCE_SEARCH_EXCLUDES.map((glob) =>
    shellSingleQuote(`:(exclude)${glob.slice(1)}`),
  ).join(" ");
  const rgGlobs = SOURCE_SEARCH_EXCLUDES.map(
    (glob) => `--glob ${shellSingleQuote(glob)}`,
  ).join(" ");
  const findPrunes = SOURCE_SEARCH_EXCLUDES.map((glob) =>
    glob.replace(/^!\*\*\//u, "./").replace(/\/\*\*$/u, ""),
  )
    .map((dir) => `-path ${shellSingleQuote(dir)}`)
    .join(" -o ");
  return [
    "if git rev-parse --show-toplevel >/dev/null 2>&1; then",
    `git grep -n --recurse-submodules -- ${quotedPattern} -- . ${gitExcludes} || true;`,
    "elif command -v rg >/dev/null 2>&1; then",
    `rg -n --hidden ${rgGlobs} ${quotedPattern} . || true;`,
    "else",
    `find . \\( ${findPrunes} \\) -prune -o -type f -exec grep -n -I -m 20 -- ${quotedPattern} {} + 2>/dev/null || true;`,
    "fi",
  ].join(" ");
}

export function resolveSourceInspectionCommand(args: {
  command: string;
  messageText: string;
}): SourceInspectionCommandResolution {
  if (!asksForLocalSourceInspection(args.messageText)) {
    return { command: args.command, rewritten: false };
  }
  const pattern = broadRecursiveGrepPattern(args.command);
  if (!pattern) return { command: args.command, rewritten: false };
  return {
    command: boundedSourceSearchCommand(pattern),
    rewritten: true,
  };
}

function shouldIgnoreUngroundedRuntimeCwd(args: {
  message: Memory;
  requestedCwd: string;
  sessionCwd: string;
}): boolean {
  if (path.resolve(args.requestedCwd) === path.resolve(args.sessionCwd)) {
    return false;
  }
  const text = messageText(args.message);
  if (textMentionsPath(text, args.requestedCwd)) return false;
  return asksAboutRunningRuntimeSource(text);
}

function stripShellQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTrailingShellPathPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function rewriteUngroundedRuntimeDirectoryOverrides(args: {
  command: string;
  message: Memory;
  sessionCwd: string;
}): string {
  const text = messageText(args.message);
  if (!asksAboutRunningRuntimeSource(text)) return args.command;

  const leadingCd = args.command.match(
    /^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\/[^\s;&|]+))\s*&&\s*([\s\S]+)$/u,
  );
  if (leadingCd?.[1] && leadingCd[2]) {
    const requestedPath = stripTrailingShellPathPunctuation(
      stripShellQuotes(leadingCd[1]),
    );
    if (
      path.isAbsolute(requestedPath) &&
      !textMentionsPath(text, requestedPath)
    ) {
      return leadingCd[2].trim();
    }
  }

  return args.command.replace(
    /\bgit\s+-C\s+((?:"[^"]+")|(?:'[^']+')|(?:\/[^\s;&|]+))/gu,
    (match, rawPath: string) => {
      const requestedPath = stripTrailingShellPathPunctuation(
        stripShellQuotes(rawPath),
      );
      if (
        !path.isAbsolute(requestedPath) ||
        textMentionsPath(text, requestedPath)
      ) {
        return match;
      }
      return `git -C ${shellSingleQuote(args.sessionCwd)}`;
    },
  );
}

function hasUnescapedShellUrlMetachar(token: string): boolean {
  let escaped = false;
  for (const char of token) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (SHELL_URL_METACHARS.has(char)) return true;
  }
  return false;
}

function shellSingleQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

function quoteBareUrlsWithShellMetacharacters(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (escaped) {
      out += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      out += char;
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    const prefix = URL_PREFIXES.find((candidate) =>
      command.startsWith(candidate, index),
    );
    if (!prefix) {
      out += char;
      index += 1;
      continue;
    }

    let end = index + prefix.length;
    while (end < command.length) {
      const next = command[end];
      if (/\s/.test(next) || next === "'" || next === '"') break;
      end += 1;
    }

    const token = command.slice(index, end);
    out += hasUnescapedShellUrlMetachar(token)
      ? shellSingleQuote(token)
      : token;
    index = end;
  }

  return out;
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readNestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string") {
    const parsed = Number(current.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function cryptoSpotSourceForCommand(command: string): string | undefined {
  const lower = command.toLowerCase();
  if (lower.includes("api.coingecko.com")) return "CoinGecko";
  if (lower.includes("api.coinbase.com")) return "Coinbase";
  return undefined;
}

function priceFromCryptoSpotOutput(args: {
  asset: CryptoSpotAsset;
  command: string;
  stdout: string;
}): { price: number; source: string } | undefined {
  const parsed = extractJsonPayload(args.stdout);
  const source = cryptoSpotSourceForCommand(args.command);
  if (parsed) {
    const coingeckoPrice = readNestedNumber(parsed, [
      args.asset.coingeckoId,
      "usd",
    ]);
    if (coingeckoPrice !== undefined) {
      return { price: coingeckoPrice, source: source ?? "CoinGecko" };
    }
    const coinbaseAmount = readNestedNumber(parsed, ["data", "amount"]);
    if (coinbaseAmount !== undefined) {
      return { price: coinbaseAmount, source: source ?? "Coinbase" };
    }
    const binancePrice = readNestedNumber(parsed, ["price"]);
    if (binancePrice !== undefined && source) {
      return { price: binancePrice, source };
    }
  }

  const numeric = Number(args.stdout.trim().replace(/[$,]/g, ""));
  if (Number.isFinite(numeric) && source) {
    return { price: numeric, source };
  }
  return undefined;
}

function formatUsd(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: price >= 1 ? 2 : 6,
  }).format(price);
}

function cryptoSpotUserFacingText(args: {
  message: Memory;
  command: string;
  stdout: string;
}): string | undefined {
  const asset = requestedCryptoSpotAsset(messageText(args.message));
  if (!asset) return undefined;
  const result = priceFromCryptoSpotOutput({
    asset,
    command: args.command,
    stdout: args.stdout,
  });
  if (!result) return undefined;
  return `${asset.symbol} price: ${formatUsd(result.price)} USD (source: ${result.source}).`;
}

function healthUserFacingText(stdout: string): string | undefined {
  const parsed = extractJsonPayload(stdout);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const plugins = record.plugins as Record<string, unknown> | undefined;
  const ready = record.ready;
  const loaded = plugins?.loaded;
  const failed = plugins?.failed;
  const readyText = typeof ready === "boolean" ? String(ready) : undefined;
  if (!readyText && loaded === undefined && failed === undefined) {
    return undefined;
  }
  const parts = [`ready=${readyText ?? "unknown"}`];
  if (loaded !== undefined || failed !== undefined) {
    parts.push(
      `plugins loaded=${loaded ?? "unknown"}, failed=${failed ?? "unknown"}`,
    );
  }
  return `Health: ${parts.join("; ")}.`;
}

function memoryUserFacingText(stdout: string): string | undefined {
  const memLine = stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().toLowerCase().startsWith("mem:"));
  if (!memLine) return undefined;
  const parts = memLine.trim().split(/\s+/u);
  const total = parts[1];
  const free = parts[3];
  const available = parts[6];
  if (!total || !free) return undefined;
  return `Free RAM: ${free} MB (${available ?? "unknown"} MB available) of ${total} MB total.`;
}

function localStatusUserFacingText(args: {
  message: Memory;
  stdout: string;
}): string | undefined {
  const kind = requestedLocalStatusKind(messageText(args.message));
  if (kind === "health") return healthUserFacingText(args.stdout);
  if (kind === "memory") return memoryUserFacingText(args.stdout);
  return undefined;
}

function formatStreams(
  stdout: string,
  stderr: string,
  options: { showEmptyStreams?: boolean } = {},
): string {
  const sOut = truncate(stdout, STREAM_CAP_CHARS);
  const sErr = truncate(stderr, STREAM_CAP_CHARS);
  const lines: string[] = [];
  if (sOut.text.length > 0 || options.showEmptyStreams) {
    lines.push("--- stdout ---");
    lines.push(sOut.text.length > 0 ? sOut.text : "(empty)");
  }
  if (sErr.text.length > 0 || options.showEmptyStreams) {
    lines.push("--- stderr ---");
    lines.push(sErr.text.length > 0 ? sErr.text : "(empty)");
  }
  return lines.join("\n");
}

export const shellAction: Action = {
  name: "SHELL",
  contexts: [...CODING_TOOLS_CONTEXTS],
  roleGate: { minRole: "OWNER" },
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["BASH", "EXEC", "RUN_COMMAND"],
  description:
    "Shell action. action=run executes command via local shell. action=clear_history clears conversation command history. action=view_history returns recent commands. command required only for run. Prefer bounded commands; avoid recursive whole-filesystem scans unless explicitly requested. Omit cwd unless the user supplied an exact directory or the session was explicitly moved; do not invent cwd from remembered repo paths. For questions about the currently running agent/runtime/source, use the default session cwd and inspect current process/service evidence before reporting git metadata. For JSON API inspection, prefer jq or node; if Python is needed, call python3 rather than assuming a python alias exists. For public unauthenticated API reads, quote URLs and prefer stable no-key endpoints; avoid deprecated, region-blocked, or exchange-gated endpoints when a neutral data API can answer the same question. For crypto spot prices, prefer neutral no-key APIs such as CoinGecko simple price or Coinbase spot before exchange-gated APIs; do not start with legacy Coindesk or Binance when the same value can be fetched elsewhere. If a command exits 0 with empty stdout/stderr, the command produced no output; try another source or parser when data is still needed instead of claiming the shell did not return output. For disk checks, use df for every requested mount/path (for root plus home: df -h / /home) plus targeted du on likely cleanup directories; when asked for cleanup candidates, inspect one readable largest directory one level deeper before ranking candidates. Use separators that still allow later inspection commands to run when du hits expected permission-denied paths.",
  descriptionCompressed: "Run shell commands; clear/view shell history.",
  parameters: [
    {
      name: "action",
      description: "Shell operation: run | clear_history | view_history.",
      required: false,
      schema: {
        type: "string",
        enum: ["run", "clear_history", "view_history"],
      },
    },
    {
      name: "command",
      description:
        "For action=run: shell command, executed via /bin/bash -c. Keep routine inspection commands bounded; avoid broad scans like du -sh /* when a targeted path is enough. For JSON API data, prefer jq or node; use python3, not python, unless the environment explicitly shows python exists. For public unauthenticated API reads, quote URLs and prefer stable no-key endpoints; avoid deprecated, region-blocked, or exchange-gated endpoints when a neutral data API can answer the same question. For crypto spot prices, prefer CoinGecko simple price or Coinbase spot before exchange-gated APIs; avoid legacy Coindesk and Binance when a neutral source can answer. If stdout/stderr are marked empty, the command produced no output; try a different command/source when the user still needs a value. Include every requested path in df, e.g. df -h / /home. For cleanup candidates, follow the first bounded du result with a targeted du on the largest readable directory before answering; avoid && between du probes when permission-denied paths are expected.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "5-10 word human-readable command summary.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description:
        "Hard timeout in ms; clamped to [100, 600000]. Default 120000.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "cwd",
      description:
        "Absolute cwd; must not resolve under blocked path. Omit unless the user supplied this exact directory or the session was explicitly moved; default session cwd is safer than remembered paths.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "For action=view_history: max recorded commands.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const explicitSubaction = readStringParam(options, "action");
    const inferredSubaction = inferShellSubactionFromText(
      message.content?.text ?? "",
    );
    const subaction = explicitSubaction
      ? normalizeShellSubaction(explicitSubaction)
      : (inferredSubaction ?? "run");

    if (subaction === "clear_history" || subaction === "view_history") {
      const shellHistoryService = getShellHistoryService(runtime);
      if (!shellHistoryService) {
        return failureToActionResult({
          reason: "internal",
          message: "Shell history service unavailable.",
        });
      }
      const conversationId = message.roomId || message.agentId;
      if (!conversationId) {
        return failureToActionResult({
          reason: "missing_param",
          message: "no conversation id",
        });
      }
      if (subaction === "clear_history") {
        if (typeof shellHistoryService.clearCommandHistory !== "function") {
          return failureToActionResult({
            reason: "internal",
            message: "Shell history clearing is unavailable.",
          });
        }
        shellHistoryService.clearCommandHistory(String(conversationId));
        const text = "Shell command history has been cleared.";
        if (callback) await callback({ text, source: "coding-tools" });
        return successActionResult(text, {
          actionName: "SHELL",
          [CANONICAL_SUBACTION_KEY]: "clear_history",
        });
      }

      if (typeof shellHistoryService.getCommandHistory !== "function") {
        return failureToActionResult({
          reason: "internal",
          message: "Shell history reading is unavailable.",
        });
      }
      const limit = clampHistoryLimit(readNumberParam(options, "limit"));
      const entries = shellHistoryService.getCommandHistory(
        String(conversationId),
        limit,
      );
      const lines = entries.length
        ? entries
            .map((entry, index) => {
              const command =
                typeof entry.command === "string"
                  ? entry.command
                  : JSON.stringify(entry);
              return `${index + 1}. ${command}`;
            })
            .join("\n")
        : "(no shell history recorded for this conversation)";
      const text = `Shell command history (last ${entries.length}):\n${lines}`;
      if (callback) await callback({ text, source: "coding-tools" });
      return successActionResult(text, {
        actionName: "SHELL",
        [CANONICAL_SUBACTION_KEY]: "view_history",
        entryCount: entries.length,
      });
    }

    const rawCommand = readStringParam(options, "command");
    if (!rawCommand || rawCommand.trim().length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "SHELL requires 'command' (string)",
      });
    }
    let command = quoteBareUrlsWithShellMetacharacters(rawCommand);
    if (command !== rawCommand) {
      coreLogger.debug(
        `${CODING_TOOLS_LOG_PREFIX} SHELL quoted bare URL metacharacters before execution`,
      );
    }
    const cwdParam = readStringParam(options, "cwd");

    if (!message.roomId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }
    const conversationId = String(message.roomId);

    const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
      typeof SandboxService
    > | null;
    const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
      typeof SessionCwdService
    > | null;
    if (!sandbox || !session) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    let cwd = "";
    if (cwdParam) {
      const v = await sandbox.validatePath(conversationId, cwdParam);
      if (v.ok === false) {
        return failureToActionResult({
          reason: v.reason === "blocked" ? "path_blocked" : "invalid_param",
          message: v.message,
        });
      }
      try {
        const stat = await fs.stat(v.resolved);
        if (!stat.isDirectory()) {
          return failureToActionResult({
            reason: "invalid_param",
            message: `cwd is not a directory: ${cwdParam}`,
          });
        }
      } catch (err) {
        if (!isMissingPathError(err)) {
          return failureToActionResult({
            reason: "io_error",
            message: `cwd stat failed: ${(err as Error).message}`,
          });
        }
        const fallback = await session.getExistingCwd(conversationId);
        cwd = fallback.cwd;
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} SHELL cwd not found; using session cwd (requested=${cwdParam}, fallback=${cwd})`,
        );
        if (fallback.reset && fallback.previousCwd) {
          coreLogger.warn(
            `${CODING_TOOLS_LOG_PREFIX} SHELL reset missing session cwd (previous=${fallback.previousCwd}, fallback=${cwd})`,
          );
        }
      }
      const sessionCwd = await session.getExistingCwd(conversationId);
      if (
        shouldIgnoreUngroundedRuntimeCwd({
          message,
          requestedCwd: v.resolved,
          sessionCwd: sessionCwd.cwd,
        })
      ) {
        cwd = sessionCwd.cwd;
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} SHELL ignored ungrounded runtime cwd; using session cwd (requested=${v.resolved}, fallback=${cwd})`,
        );
        if (sessionCwd.reset && sessionCwd.previousCwd) {
          coreLogger.warn(
            `${CODING_TOOLS_LOG_PREFIX} SHELL reset missing session cwd (previous=${sessionCwd.previousCwd}, fallback=${cwd})`,
          );
        }
      }
      if (!cwd) cwd = v.resolved;
    } else {
      const sessionCwd = await session.getExistingCwd(conversationId);
      cwd = sessionCwd.cwd;
      if (sessionCwd.reset && sessionCwd.previousCwd) {
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} SHELL reset missing session cwd (previous=${sessionCwd.previousCwd}, fallback=${cwd})`,
        );
      }
    }

    const groundedCommand = rewriteUngroundedRuntimeDirectoryOverrides({
      command,
      message,
      sessionCwd: cwd,
    });
    if (groundedCommand !== command) {
      command = groundedCommand;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} SHELL removed ungrounded runtime directory override; using cwd=${cwd}`,
      );
    }
    const localStatusCommand = resolveLocalStatusCommand({
      command,
      messageText: messageText(message),
    });
    if (localStatusCommand.rewritten) {
      command = localStatusCommand.command;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} SHELL replaced local status probe with canonical command`,
      );
    }
    const sourceInspectionCommand = resolveSourceInspectionCommand({
      command,
      messageText: messageText(message),
    });
    if (sourceInspectionCommand.rewritten) {
      command = sourceInspectionCommand.command;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} SHELL replaced broad source search with bounded workspace search`,
      );
    }
    const diskCommand = resolveDiskInspectionCommand({
      command,
      messageText: messageText(message),
    });
    if (diskCommand.rewritten) {
      command = diskCommand.command;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} SHELL replaced broad disk scan with bounded cleanup-candidate probe`,
      );
    }
    const cryptoCommand = resolveCryptoSpotPriceCommand({
      command,
      messageText: messageText(message),
    });
    if (cryptoCommand.rewritten) {
      command = cryptoCommand.command;
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} SHELL replaced unreliable crypto spot-price endpoint with neutral no-key API`,
      );
    }

    const defaultTimeout = readPositiveIntSetting(
      runtime,
      "CODING_TOOLS_SHELL_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    );
    const timeout = clampTimeout(
      readNumberParam(options, "timeout"),
      defaultTimeout,
    );

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} SHELL cwd=${cwd} timeout=${timeout}ms`,
    );

    const startedAt = Date.now();
    const mode = resolveRuntimeExecutionMode(runtime);
    if (mode === "cloud") {
      coreLogger.error(
        `${CODING_TOOLS_LOG_PREFIX} SHELL cloud-mode denied: local exec disabled`,
      );
      return failureToActionResult(
        {
          reason: "internal",
          message: "Local shell execution disabled in cloud mode.",
        },
        { cwd },
      );
    }

    coreLogger.info(`${CODING_TOOLS_LOG_PREFIX} SHELL mode=${mode} cwd=${cwd}`);

    let result: ShellResult;
    try {
      result = await runShell(runtime, { command, cwd, timeoutMs: timeout });
    } catch (err) {
      const message = (err as Error).message;
      coreLogger.error(
        `${CODING_TOOLS_LOG_PREFIX} SHELL dispatch failed: ${message}`,
      );
      return failureToActionResult({ reason: "internal", message }, { cwd });
    }

    const took = Date.now() - startedAt;
    const timedOut = result.timedOut;
    const signal = result.signal;
    const head = timedOut
      ? `$ ${command}\n[timeout ${timeout}ms] (cwd=${cwd}, took=${took}ms)`
      : `$ ${command}\n[exit ${result.exitCode}] (cwd=${cwd}, took=${took}ms)`;
    const streams = formatStreams(result.stdout, result.stderr, {
      showEmptyStreams: !result.stdout && !result.stderr,
    });
    const text = streams.length > 0 ? `${head}\n${streams}` : head;

    if (callback) await callback({ text, source: "coding-tools" });

    if (timedOut) {
      return failureToActionResult(
        { reason: "timeout", message: `command timed out after ${timeout}ms` },
        { cwd, output: text },
      );
    }
    if (result.exitCode !== 0) {
      return failureToActionResult(
        {
          reason: "command_failed",
          message: `command exited with code ${result.exitCode}`,
        },
        { exit_code: result.exitCode, cwd, output: text },
      );
    }
    const actionResult = successActionResult(text, {
      exit_code: result.exitCode,
      cwd,
      execution_route: result.sandbox === "host" ? "host" : "sandbox",
      sandbox_backend: result.sandbox,
      signal,
    });
    const userFacingText =
      cryptoSpotUserFacingText({
        message,
        command,
        stdout: result.stdout,
      }) ?? localStatusUserFacingText({ message, stdout: result.stdout });
    return userFacingText ? { ...actionResult, userFacingText } : actionResult;
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Run `git status` in the current repo.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ git status\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Plain shell command request maps to SHELL with command='git status' in the session cwd.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Build the project: run `bun run build` with a 5-minute timeout.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ bun run build\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Long-running build maps to SHELL with command and timeout=300000 to fit the 5-minute window.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What branch and commit is the currently running local source using?",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ pwd; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Questions about the currently running source use SHELL in the default session cwd; do not set cwd from remembered repo paths unless the user provided an exact path.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Check disk space and safe cleanup candidates.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '$ df -h / /home; du -x -h --max-depth=1 /home 2>/dev/null | sort -hr | head -n 5; du -x -h --max-depth=2 "$HOME" 2>/dev/null | sort -hr | head -n 8\n[exit 0]',
          actions: ["SHELL"],
          thought:
            "Disk checks should use df for mount usage, then bounded du probes that still run after permission-denied paths and inspect the largest readable directory one level deeper before ranking cleanup candidates.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Fetch a current JSON API value.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ curl -s \"https://api.example.com/status?format=json\" | jq -r '.status'\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Current JSON API checks should keep the URL quoted and parse with jq or node; do not assume a python binary exists when python3 is the portable Python command.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Check the current BTC price in USD.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "$ curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd' | jq -r '.bitcoin.usd'\n[exit 0]",
          actions: ["SHELL"],
          thought:
            "Public spot-price checks should start with a neutral no-key API such as CoinGecko or Coinbase instead of deprecated or exchange-gated endpoints.",
        },
      },
    ],
  ],
};
