import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveBrowserWorkspaceElementRef } from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceMode,
  BrowserWorkspaceSubaction,
} from "./browser-workspace-types.js";

export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_WAIT_INTERVAL_MS = 120;
export const DEFAULT_WEB_PARTITION = "persist:eliza-browser";
export const CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX =
  "persist:connector-";
export const DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE =
  "Eliza browser workspace desktop bridge is unavailable.";
export const browserWorkspacePageFetch = globalThis.fetch.bind(globalThis);

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
    throw new Error(`browser workspace rejected invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
  if (!normalized) {
    throw new Error(`Eliza browser connector session requires ${fieldName}.`);
  }
  return normalized;
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
  return `${CONNECTOR_BROWSER_WORKSPACE_PARTITION_PREFIX}${providerSegment}-${accountSegment}`;
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
  throw new Error(
    `Connector browser sessions do not allow raw cookie, token, storage, or state export (${operation}). Use the returned partition/profile/session handle instead.`,
  );
}

export function createBrowserWorkspaceDesktopOnlyMessage(
  subaction: BrowserWorkspaceSubaction,
): string {
  return `Eliza browser workspace ${subaction} is only available in the desktop app.`;
}

export function createBrowserWorkspaceNotFoundError(tabId: string): Error {
  return new Error(
    `Browser workspace request failed (404): Tab ${tabId} was not found.`,
  );
}

export function createBrowserWorkspaceCommandTargetError(
  subaction: BrowserWorkspaceSubaction,
): Error {
  return new Error(
    `Eliza browser workspace ${subaction} requires a current tab. Open or show a tab first, or pass an explicit id.`,
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function writeBrowserWorkspaceFile(
  filePath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const resolved = path.resolve(filePath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, contents);
  return resolved;
}

export function normalizeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
): BrowserWorkspaceCommand {
  const raw = command as BrowserWorkspaceCommand & Record<string, unknown>;
  const normalizedSubaction =
    typeof raw.subaction === "string"
      ? raw.subaction.trim().toLowerCase()
      : typeof raw.operation === "string"
        ? raw.operation.trim().toLowerCase()
        : "";
  const subaction =
    normalizedSubaction === "goto"
      ? "navigate"
      : normalizedSubaction === "read"
        ? "get"
        : command.subaction;
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

export function resolveBrowserWorkspaceCommandElementRefs(
  command: BrowserWorkspaceCommand,
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceCommand {
  const selector = command.selector?.trim();
  if (!selector) {
    return command;
  }

  const match = selector.match(/^(@e\d+)([\s\S]*)$/i);
  if (!match?.[1]) {
    return command;
  }

  const resolvedSelector = resolveBrowserWorkspaceElementRef(
    mode,
    tabId,
    match[1],
  );
  if (!resolvedSelector) {
    throw new Error(
      `Unknown browser snapshot element ref ${match[1]}. Run snapshot or inspect again before reusing element refs.`,
    );
  }

  return {
    ...command,
    selector: `${resolvedSelector}${match[2] ?? ""}`,
  };
}

export function buildBrowserWorkspaceCssStringLiteral(value: string): string {
  return JSON.stringify(value);
}
