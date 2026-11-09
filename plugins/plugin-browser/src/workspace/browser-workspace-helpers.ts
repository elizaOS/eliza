/**
 * Shared browser workspace utilities for command normalization, tabs, URLs,
 * and workspace-rooted file reads/writes.
 *
 * Command `filePath` / `outputPath` / `baselinePath` values are confined with a
 * realpath ancestor walk so a symlink parent cannot smuggle a write or state
 * load outside the process working directory.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { browserBridgeDomainFromUrl } from "../bridge-policy.js";
import { evaluateBrowserDomainPolicies } from "../browser-domain-policy.js";
import { BrowserDispatchFailure } from "../dispatch-types.js";
import { buildBrowserWorkspaceElementSelector } from "./browser-workspace-elements.js";
import { createBrowserWorkspaceError } from "./browser-workspace-errors.js";
import { resolveBrowserWorkspaceElementRef } from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceDesktopElementRef,
  BrowserWorkspaceMode,
  BrowserWorkspaceSubaction,
} from "./browser-workspace-types.js";

export const DEFAULT_TIMEOUT_MS = 12_000;
/** Transport budget for a command that runs in a real page (eval/Playwright). */
export const BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const BROWSER_COMMAND_TIMEOUT_GRACE_MS = 5_000;

/** Keeps the transport alive long enough for commands with their own longer deadline. */
export function resolveBrowserCommandTimeoutMs(
  command: Pick<BrowserWorkspaceCommand, "timeoutMs">,
  defaultTimeoutMs: number = BROWSER_COMMAND_TIMEOUT_MS,
): number {
  const requestedTimeoutMs = command.timeoutMs;
  if (
    typeof requestedTimeoutMs !== "number" ||
    !Number.isFinite(requestedTimeoutMs) ||
    requestedTimeoutMs < 0
  ) {
    return defaultTimeoutMs;
  }
  return Math.max(
    defaultTimeoutMs,
    requestedTimeoutMs + BROWSER_COMMAND_TIMEOUT_GRACE_MS,
  );
}
export const DEFAULT_WAIT_INTERVAL_MS = 120;
export const DEFAULT_WEB_PARTITION = "persist:eliza-browser";
export const CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX =
  "persist:connector-";
export const DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE =
  "Eliza browser workspace desktop bridge is unavailable.";
export const browserWorkspacePageFetch = globalThis.fetch.bind(globalThis);

/**
 * Page fetch with a hop deadline, so a host that accepts the connection and
 * never answers cannot pin a browser workspace command indefinitely.
 *
 * A caller-provided abort signal composes with the deadline rather than
 * replacing it: the caller can still cancel early, and the bound still applies
 * when the caller's signal never fires.
 */
export async function browserWorkspaceBoundedPageFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return browserWorkspacePageFetch(url, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

const BROWSER_WORKSPACE_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const MAX_BROWSER_WORKSPACE_DOCUMENT_REDIRECTS = 10;

function assertBrowserWorkspaceReadAllowed(url: string, subaction: string) {
  const decision = evaluateBrowserDomainPolicies({
    subaction,
    effect: "read",
    domain: browserBridgeDomainFromUrl(url),
    url,
    targetId: "workspace",
    phase: "dispatch",
  });
  if (decision.verdict !== "allow") {
    throw new BrowserDispatchFailure(
      "POLICY_BLOCKED",
      `Browser read of "${url}" was blocked by domain policy "${decision.policyId}": ${decision.reason}`,
      { targetId: "workspace" },
    );
  }
}

/**
 * Fetches a page document for a command that reads a caller-supplied URL
 * (diff url): http(s) only, redirects followed by hand with the URL check and
 * the domain policy applied to every hop, each hop under the page deadline.
 * `fetchHop` lets the web backend record the hops in its network log.
 */
export async function browserWorkspaceGuardedDocumentFetch(
  rawUrl: string,
  subaction: string,
  fetchHop: (url: string, init: RequestInit) => Promise<Response> = (
    url,
    init,
  ) => browserWorkspaceBoundedPageFetch(url, init),
): Promise<{ url: string; text: string }> {
  let requestUrl = assertBrowserWorkspaceUrl(rawUrl);
  for (let hop = 0; hop <= MAX_BROWSER_WORKSPACE_DOCUMENT_REDIRECTS; hop += 1) {
    assertBrowserWorkspaceReadAllowed(requestUrl, subaction);
    const response = await fetchHop(requestUrl, { redirect: "manual" });
    if (!BROWSER_WORKSPACE_REDIRECT_STATUSES.has(response.status)) {
      return { url: requestUrl, text: await response.text() };
    }
    const location = response.headers.get("location")?.trim();
    if (!location) {
      throw new Error(
        `Browser workspace redirect (${response.status}) from "${requestUrl}" has no Location header.`,
      );
    }
    requestUrl = assertBrowserWorkspaceUrl(
      new URL(location, requestUrl).toString(),
    );
  }
  throw new Error(
    `Browser workspace page read exceeded ${MAX_BROWSER_WORKSPACE_DOCUMENT_REDIRECTS} redirects: ${rawUrl}`,
  );
}

export function normalizeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeBrowserWorkspaceText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const BROWSER_WORKSPACE_BLOCK_SELECTOR =
  "address, article, aside, blockquote, body, caption, dd, details, dialog, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, li, main, nav, ol, option, p, pre, section, summary, table, tbody, td, tfoot, th, thead, tr, ul";

/** Page prose only; raw HTML remains available through the explicit html read. */
export function readBrowserWorkspaceElementText(
  element: Element | null,
): string {
  if (!element || element.closest("script, style, template")) return "";
  // SHOW_ELEMENT | SHOW_TEXT: walk without cloning or modifying the document being controlled.
  const walker = element.ownerDocument.createTreeWalker(element, 5);
  const text: string[] = [];
  let previousBlock: Element | null | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("script, style, template")) continue;
    if (node.nodeName === "BR" || node.nodeName === "HR") {
      text.push(" ");
    } else if (node.nodeType === 3) {
      // Text in a different block than the preceding text starts a new line;
      // inline elements share their block and stay unseparated.
      const block = node.parentElement?.closest(
        BROWSER_WORKSPACE_BLOCK_SELECTOR,
      );
      if (block !== previousBlock) text.push(" ");
      previousBlock = block;
      text.push(node.nodeValue ?? "");
    }
  }
  return normalizeBrowserWorkspaceText(text.join(""));
}

const BROWSER_WORKSPACE_PRIVATE_INPUT_TYPES = ["password", "hidden"];

/** Ambient page context may describe these controls, but must not copy values. */
export function isBrowserWorkspacePrivateControl(element: Element): boolean {
  return (
    element.tagName === "INPUT" &&
    BROWSER_WORKSPACE_PRIVATE_INPUT_TYPES.includes(
      String((element as HTMLInputElement).type).toLowerCase(),
    )
  );
}

/** The same rule as page-script source, for scripts evaluated in a desktop tab. */
export const BROWSER_WORKSPACE_PRIVATE_CONTROL_SCRIPT = `(element) =>
    Boolean(element) &&
    element.tagName === "INPUT" &&
    ${JSON.stringify(BROWSER_WORKSPACE_PRIVATE_INPUT_TYPES)}.includes(String(element.type).toLowerCase())`;

export function parseBrowserWorkspaceNumberLike(
  value: unknown,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function assertBrowserWorkspaceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "about:blank") {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createBrowserWorkspaceError(
      "invalid_url",
      "url_validation",
      `browser workspace rejected invalid URL: ${rawUrl}`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createBrowserWorkspaceError(
      "invalid_url",
      "url_validation",
      `browser workspace only supports http/https URLs, got ${parsed.protocol}`,
    );
  }

  return parsed.toString();
}

export function inferBrowserWorkspaceTitle(url: string): string {
  if (url === "about:blank") {
    return "New Tab";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Eliza Browser";
  } catch {
    return "Eliza Browser";
  }
}

function normalizeConnectorBrowserWorkspaceSegment(
  value: string,
  fieldName: string,
): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  const normalized = slug.slice(start, end).slice(0, 64);
  if (!normalized) {
    throw new Error(`Eliza browser connector session requires ${fieldName}.`);
  }
  return normalized;
}

function hashConnectorBrowserWorkspacePartitionKey(
  provider: string,
  accountId: string,
): string {
  const input = `${provider.trim().toLowerCase()}\0${accountId.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

export function resolveConnectorBrowserWorkspacePartition(
  provider: string,
  accountId: string,
): string {
  const providerSegment = normalizeConnectorBrowserWorkspaceSegment(
    provider,
    "provider",
  );
  const accountSegment = normalizeConnectorBrowserWorkspaceSegment(
    accountId,
    "accountId",
  );
  const suffix = hashConnectorBrowserWorkspacePartitionKey(provider, accountId);
  return `${CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX}${providerSegment}-${accountSegment}-${suffix}`;
}

export function isConnectorBrowserWorkspacePartition(
  partition: string | null | undefined,
): boolean {
  return (partition ?? "")
    .trim()
    .toLowerCase()
    .startsWith(CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX);
}

export function resolveBrowserWorkspaceCommandPartition(
  command: Pick<
    BrowserWorkspaceCommand,
    "connectorAccountId" | "connectorProvider" | "partition"
  >,
  fallbackPartition: string,
): string {
  const explicitPartition = command.partition?.trim();
  if (explicitPartition) {
    return explicitPartition;
  }
  const provider = command.connectorProvider?.trim();
  const accountId = command.connectorAccountId?.trim();
  if (provider && accountId) {
    return resolveConnectorBrowserWorkspacePartition(provider, accountId);
  }
  return fallbackPartition;
}

export function assertBrowserWorkspaceConnectorSecretsNotExported(
  partition: string | null | undefined,
  operation: string,
): void {
  if (!isConnectorBrowserWorkspacePartition(partition)) {
    return;
  }
  throw createBrowserWorkspaceError(
    "connector_secret_export_forbidden",
    operation,
    `Connector browser sessions do not allow raw cookie, token, storage, or state export (${operation}). Use the returned partition/profile/session handle instead.`,
  );
}

export function createBrowserWorkspaceDesktopOnlyMessage(
  subaction: BrowserWorkspaceSubaction,
): string {
  return `Eliza browser workspace ${subaction} is only available in the desktop app.`;
}

export function createBrowserWorkspaceNotFoundError(tabId: string): Error {
  return createBrowserWorkspaceError(
    "tab_not_found",
    "tab_lookup",
    `Browser workspace request failed (404): Tab ${tabId} was not found.`,
  );
}

export function createBrowserWorkspaceCommandTargetError(
  subaction: BrowserWorkspaceSubaction,
): Error {
  return createBrowserWorkspaceError(
    "target_missing",
    subaction,
    `Eliza browser workspace ${subaction} requires a current tab. Open or show a tab first, or pass an explicit id.`,
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Separator-aware containment: `..safe.js` is a sibling name, not a traversal.
 * Compare realpaths so macOS `/var` vs `/private/var` is not a false escape.
 */
export function isWithinBrowserWorkspaceRoot(
  child: string,
  parent: string,
): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Realpath the longest existing ancestor, then rejoin the missing tail so a
 * workspace symlink-to-elsewhere cannot hide behind a not-yet-created basename.
 */
export function resolveBrowserWorkspaceRealPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // error-policy:J3 missing leaf — walk up to the longest existing prefix.
  }
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    try {
      return path.join(fs.realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}

/**
 * Confine a command-supplied filesystem path to `root` (default: process cwd).
 * Rejects UNC, NUL, empty, lexical `..`, and symlink-parent escapes.
 */
export function resolveBrowserWorkspaceFilePath(
  filePath: string,
  root: string = process.cwd(),
): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected an empty file path",
    );
  }
  if (trimmed.includes("\0")) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected a NUL in file path",
    );
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      "browser workspace rejected a UNC file path",
    );
  }
  const rootReal = resolveBrowserWorkspaceRealPath(root);
  const resolved = resolveBrowserWorkspaceRealPath(trimmed);
  if (
    resolved !== rootReal &&
    !isWithinBrowserWorkspaceRoot(resolved, rootReal)
  ) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      `browser workspace file path escapes the workspace root: ${trimmed}`,
    );
  }
  return resolved;
}

/**
 * Writes inside the workspace root. Path confinement resolves a dangling
 * symlink at the leaf to its own name inside the root, so the leaf is checked
 * here: a symlink is refused, and O_NOFOLLOW (where the platform has it) makes
 * the open itself refuse one created after the check.
 */
export async function writeBrowserWorkspaceFile(
  filePath: string,
  contents: string | Uint8Array,
  root: string = process.cwd(),
): Promise<string> {
  const resolved = resolveBrowserWorkspaceFilePath(filePath, root);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const leaf = await fsp.lstat(resolved).catch(() => null);
  if (leaf?.isSymbolicLink()) {
    throw createBrowserWorkspaceError(
      "path_forbidden",
      "file_path",
      `browser workspace will not write through a symbolic link: ${filePath.trim()}`,
    );
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(resolved, flags, 0o666);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw createBrowserWorkspaceError(
        "path_forbidden",
        "file_path",
        `browser workspace will not write through a symbolic link: ${filePath.trim()}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  return resolved;
}

export function normalizeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
): BrowserWorkspaceCommand {
  const raw = command as BrowserWorkspaceCommand & Record<string, unknown>;
  // A trimmed-empty `subaction` is absent, not a value: fall back to
  // `operation` before resolving so whitespace cannot mask a valid alias.
  // Precedence is explicit — a non-empty `subaction` always wins over
  // `operation`; the raw `command.subaction` is only restored when neither
  // yields a usable token, preserving the executor's unsupported-subaction
  // diagnostic.
  const trimmedSubaction =
    typeof raw.subaction === "string" ? raw.subaction.trim().toLowerCase() : "";
  const trimmedOperation =
    typeof raw.operation === "string" ? raw.operation.trim().toLowerCase() : "";
  const normalizedSubaction = trimmedSubaction || trimmedOperation;
  const subaction =
    normalizedSubaction === "goto"
      ? "navigate"
      : normalizedSubaction === "read"
        ? "get"
        : ((normalizedSubaction ||
            command.subaction) as BrowserWorkspaceSubaction);
  const timeoutMs =
    parseBrowserWorkspaceNumberLike(command.timeoutMs) ??
    parseBrowserWorkspaceNumberLike(raw.ms) ??
    parseBrowserWorkspaceNumberLike(raw.milliseconds);

  return {
    ...command,
    subaction,
    timeoutMs,
    steps: Array.isArray(command.steps)
      ? command.steps.map((step) => normalizeBrowserWorkspaceCommand(step))
      : command.steps,
  };
}

const BROWSER_WORKSPACE_ELEMENT_REF_PATTERN = /^(@e\d+)([\s\S]*)$/i;

export function createBrowserWorkspaceUnknownElementRefError(
  ref: string,
): Error {
  return createBrowserWorkspaceError(
    "unknown_element_ref",
    "element_ref",
    `Unknown browser snapshot element ref ${ref}. Run snapshot or inspect again before reusing element refs.`,
  );
}

/**
 * Resolves `@eN` refs in `selector` (and in drag's `value`) to the element the
 * last inspect or snapshot bound them to. Web refs become a selector built
 * from the live element; a ref whose element was removed fails. Desktop refs
 * become an `elementRef` the page script resolves through its own table, so a
 * navigation, which discards that table, fails closed too. Neither re-queries
 * the selector recorded at inspect time.
 */
export function resolveBrowserWorkspaceCommandElementRefs(
  command: BrowserWorkspaceCommand,
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceCommand {
  const resolveRef = (
    raw: string | undefined,
  ): {
    selector?: string;
    elementRef?: BrowserWorkspaceDesktopElementRef;
  } | null => {
    const match = raw?.trim().match(BROWSER_WORKSPACE_ELEMENT_REF_PATTERN);
    if (!match?.[1]) {
      return null;
    }
    const target = resolveBrowserWorkspaceElementRef(mode, tabId, match[1]);
    const suffix = match[2] ?? "";
    if (target?.tableId !== undefined && target.index !== undefined) {
      return {
        elementRef: { tableId: target.tableId, index: target.index },
        selector: suffix.trim() || undefined,
      };
    }
    const element = target?.element?.deref();
    if (!element?.isConnected) {
      throw createBrowserWorkspaceUnknownElementRefError(match[1]);
    }
    return {
      selector: `${buildBrowserWorkspaceElementSelector(element)}${suffix}`,
    };
  };

  let resolved = command;
  const selectorRef = resolveRef(command.selector);
  if (selectorRef) {
    resolved = {
      ...resolved,
      selector: selectorRef.selector,
      elementRef: selectorRef.elementRef,
    };
  }
  if (command.subaction === "drag") {
    const valueRef = resolveRef(command.value);
    if (valueRef) {
      resolved = {
        ...resolved,
        value: valueRef.selector,
        valueElementRef: valueRef.elementRef,
      };
    }
  }
  return resolved;
}

export function buildBrowserWorkspaceCssStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export const BROWSER_WORKSPACE_UPLOAD_UNAVAILABLE =
  "File upload is not available in this browser. Ask the user to attach the file themselves.";

export const BROWSER_WORKSPACE_FOLLOW_UNAVAILABLE =
  "Following a link from an earlier page read is only available in the native Browser.";

/** Advisory behind the script blocks; kept in error details, not the message. */
const BROWSER_WORKSPACE_SCRIPT_ADVISORY = "GHSA-mhhr-9ph9-64j7";

// GHSA-mhhr-9ph9-64j7 / elizaOS/eliza#6767 — arbitrary script must not run in
// Node (JSDOM).
export const BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN =
  "Page scripts cannot run in the web browser backend, which runs inside the agent process. Use structured subactions (click, fill, get, wait on selector/url/text) or the desktop browser instead.";

export const BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN =
  "Page scripts are disabled in the browser workspace. Use structured subactions instead.";

export function isBrowserWorkspaceUserScriptAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = normalizeEnvValue(
    env.ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT,
  )?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function assertBrowserWorkspaceUserScriptAllowed(
  script: string | undefined,
  context: "eval" | "wait",
  mode: BrowserWorkspaceMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!script?.trim()) {
    return;
  }
  if (mode === "web") {
    throw createBrowserWorkspaceJsdomScriptExecutionError(context);
  }
  // The flag only ever enables wait-condition scripts; generic eval stays off.
  if (context === "eval" || !isBrowserWorkspaceUserScriptAllowed(env)) {
    const suffix =
      context === "eval"
        ? "Generic eval is not available."
        : "Wait conditions with a script are off by default; ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT=1 turns them on, and only belongs on trusted single-user hosts.";
    throw createBrowserWorkspaceError(
      "script_forbidden",
      context,
      `${BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN} ${suffix}`,
      BROWSER_WORKSPACE_SCRIPT_ADVISORY,
    );
  }
}

export function createBrowserWorkspaceJsdomScriptExecutionError(
  context: "eval" | "wait",
): Error {
  const suffix =
    context === "eval"
      ? "Eval is not available on the web backend."
      : "Wait conditions with a script are not available on the web backend.";
  return createBrowserWorkspaceError(
    "script_forbidden",
    context,
    `${BROWSER_WORKSPACE_JSDOM_SCRIPT_FORBIDDEN} ${suffix}`,
    BROWSER_WORKSPACE_SCRIPT_ADVISORY,
  );
}

export function assertBrowserWorkspaceJsdomScriptNotRequested(
  script: string | undefined,
  context: "eval" | "wait",
): void {
  if (script?.trim()) {
    throw createBrowserWorkspaceJsdomScriptExecutionError(context);
  }
}
