import { cache } from "@/lib/cache/client";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";

export interface HostedBrowserAuthContext {
  apiKeyId?: string | null;
  organizationId?: string;
  requestSource?: "a2a" | "api" | "mcp";
  userId?: string;
}

export interface HostedBrowserTab {
  id: string;
  title: string;
  url: string;
  partition: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
  liveViewUrl?: string | null;
  interactiveLiveViewUrl?: string | null;
  status?: string | null;
  provider?: string | null;
}

export interface HostedBrowserCommand {
  subaction:
    | "back"
    | "click"
    | "eval"
    | "forward"
    | "get"
    | "navigate"
    | "press"
    | "reload"
    | "scroll"
    | "state"
    | "type"
    | "wait";
  id?: string;
  key?: string;
  pixels?: number;
  script?: string;
  selector?: string;
  text?: string;
  timeoutMs?: number;
  url?: string;
}

export interface HostedBrowserCommandResult {
  output?: unknown;
  session: HostedBrowserTab;
  snapshot?: { data: string };
}

export interface HostedExtractOptions {
  formats?: Array<"html" | "links" | "markdown" | "screenshot">;
  onlyMainContent?: boolean;
  timeoutMs?: number;
  url: string;
  waitFor?: number;
}

export interface HostedExtractResult {
  provider: "firecrawl";
  url: string;
  markdown: string | null;
  html: string | null;
  screenshot: string | null;
  links: string[];
  metadata: Record<string, unknown>;
}

interface FirecrawlBrowserListResponse {
  sessions?: FirecrawlBrowserSession[];
  success?: boolean;
}

interface FirecrawlBrowserSession {
  cdpUrl?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  id?: string | null;
  interactiveLiveViewUrl?: string | null;
  lastActivity?: string | null;
  liveViewUrl?: string | null;
  status?: string | null;
}

interface FirecrawlBrowserCreateResponse extends FirecrawlBrowserSession {
  success?: boolean;
}

interface FirecrawlBrowserDeleteResponse {
  creditsBilled?: number | null;
  sessionDurationMs?: number | null;
  success?: boolean;
}

interface FirecrawlBrowserExecuteResponse {
  error?: string | null;
  exitCode?: number | null;
  killed?: boolean | null;
  result?: string | null;
  stderr?: string | null;
  stdout?: string | null;
  success?: boolean;
}

interface FirecrawlScrapeResponse {
  data?: {
    html?: string;
    links?: string[];
    markdown?: string;
    metadata?: Record<string, unknown>;
    screenshot?: string;
  };
  success?: boolean;
}

interface FirecrawlResolvedPageState {
  title: string;
  url: string;
}

interface HostedBrowserSessionAccess {
  createdAt: string;
  organizationId: string;
  sessionId: string;
  userId: string | null;
}

const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const DEFAULT_BROWSER_ACTIVITY_TTL_SECONDS = 180;
const DEFAULT_BROWSER_TTL_SECONDS = 600;
const DEFAULT_BROWSER_TIMEOUT_SECONDS = 45;
const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_EXTRACT_WAIT_FOR_MS = 0;
const FIRECRAWL_PARTITION = "cloud:firecrawl";
const HOSTED_BROWSER_SESSION_INDEX_TTL_SECONDS = 7_200;
const hostedBrowserSessionAccessMemory = new Map<string, HostedBrowserSessionAccess>();

function getHostedBrowserSessionAccessKey(sessionId: string): string {
  return `browser:session:${sessionId}:v1`;
}

function getHostedBrowserOrganizationSessionsKey(organizationId: string): string {
  return `browser:org:${organizationId}:sessions:v1`;
}

function resolveFirecrawlApiKey(): string {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is not configured");
  }
  return apiKey;
}

function resolveFirecrawlBaseUrl(): string {
  return process.env.FIRECRAWL_API_URL?.trim().replace(/\/+$/, "") || DEFAULT_FIRECRAWL_API_URL;
}

async function firecrawlRequest<T>(pathname: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${resolveFirecrawlBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${resolveFirecrawlApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  const payload = text.trim().length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Firecrawl request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

function normalizeTabTitle(title: string | null | undefined, url: string): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  if (!url || url === "about:blank") {
    return "Browser";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

function normalizeHostedBrowserTab(
  session: FirecrawlBrowserSession,
  state: FirecrawlResolvedPageState | null,
): HostedBrowserTab {
  const createdAt = session.createdAt?.trim() || new Date().toISOString();
  const updatedAt = session.lastActivity?.trim() || createdAt;
  const url = state?.url?.trim() || "about:blank";

  return {
    id: session.id?.trim() || "",
    title: normalizeTabTitle(state?.title, url),
    url,
    partition: FIRECRAWL_PARTITION,
    visible: true,
    createdAt,
    updatedAt,
    lastFocusedAt: updatedAt,
    liveViewUrl: session.liveViewUrl?.trim() || null,
    interactiveLiveViewUrl:
      session.interactiveLiveViewUrl?.trim() || session.liveViewUrl?.trim() || null,
    status: session.status?.trim() || "active",
    provider: "firecrawl",
  };
}

function requireHostedBrowserOrganizationId(auth?: HostedBrowserAuthContext): string {
  const organizationId = auth?.organizationId?.trim();
  if (!organizationId) {
    throw new Error("Hosted browser requires authenticated organization context");
  }
  return organizationId;
}

function uniqueSessionIds(sessionIds: string[]): string[] {
  return [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))];
}

async function getStoredHostedBrowserSessionAccess(
  sessionId: string,
): Promise<HostedBrowserSessionAccess | null> {
  const inMemory = hostedBrowserSessionAccessMemory.get(sessionId);
  if (inMemory) {
    return inMemory;
  }

  const cached = await cache
    .get<HostedBrowserSessionAccess>(getHostedBrowserSessionAccessKey(sessionId))
    .catch(() => null);

  if (cached) {
    hostedBrowserSessionAccessMemory.set(sessionId, cached);
    return cached;
  }

  return null;
}

async function getStoredOrganizationSessionIds(organizationId: string): Promise<string[]> {
  const cached = await cache
    .get<string[]>(getHostedBrowserOrganizationSessionsKey(organizationId))
    .catch(() => null);

  if (Array.isArray(cached)) {
    return uniqueSessionIds(cached);
  }

  return uniqueSessionIds(
    [...hostedBrowserSessionAccessMemory.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => entry.sessionId),
  );
}

async function setStoredOrganizationSessionIds(
  organizationId: string,
  sessionIds: string[],
): Promise<void> {
  await cache
    .set(
      getHostedBrowserOrganizationSessionsKey(organizationId),
      uniqueSessionIds(sessionIds),
      HOSTED_BROWSER_SESSION_INDEX_TTL_SECONDS,
    )
    .catch(() => {});
}

async function registerHostedBrowserSessionAccess(
  sessionId: string,
  auth: HostedBrowserAuthContext | undefined,
): Promise<void> {
  const organizationId = requireHostedBrowserOrganizationId(auth);
  const access: HostedBrowserSessionAccess = {
    createdAt: new Date().toISOString(),
    organizationId,
    sessionId,
    userId: auth?.userId?.trim() || null,
  };

  hostedBrowserSessionAccessMemory.set(sessionId, access);

  const [existingIds] = await Promise.all([
    getStoredOrganizationSessionIds(organizationId),
    cache
      .set(
        getHostedBrowserSessionAccessKey(sessionId),
        access,
        HOSTED_BROWSER_SESSION_INDEX_TTL_SECONDS,
      )
      .catch(() => {}),
  ]);

  await setStoredOrganizationSessionIds(organizationId, [...existingIds, sessionId]);
}

async function removeHostedBrowserSessionAccess(
  sessionId: string,
  organizationId?: string,
): Promise<void> {
  const existing =
    hostedBrowserSessionAccessMemory.get(sessionId) ??
    (await cache
      .get<HostedBrowserSessionAccess>(getHostedBrowserSessionAccessKey(sessionId))
      .catch(() => null));

  hostedBrowserSessionAccessMemory.delete(sessionId);
  await cache.del(getHostedBrowserSessionAccessKey(sessionId)).catch(() => {});

  const targetOrganizationId = organizationId ?? existing?.organizationId;
  if (!targetOrganizationId) {
    return;
  }

  const remainingIds = (await getStoredOrganizationSessionIds(targetOrganizationId)).filter(
    (entry) => entry !== sessionId,
  );
  await setStoredOrganizationSessionIds(targetOrganizationId, remainingIds);
}

async function assertHostedBrowserSessionAccess(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserSessionAccess> {
  const organizationId = requireHostedBrowserOrganizationId(auth);
  const access = await getStoredHostedBrowserSessionAccess(sessionId);

  if (!access || access.organizationId !== organizationId) {
    throw new Error("Hosted browser session not found");
  }

  return access;
}

function parseExecutionPayload(value: string | null | undefined): unknown {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function logHostedBrowserUsage(
  auth: HostedBrowserAuthContext | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!auth?.organizationId || !auth?.userId) {
    return;
  }

  await usageService.create({
    organization_id: auth.organizationId,
    user_id: auth.userId,
    api_key_id: auth.apiKeyId ?? null,
    type: "browser",
    model: "firecrawl/browser",
    provider: "firecrawl",
    input_tokens: 0,
    output_tokens: 0,
    input_cost: "0",
    output_cost: "0",
    is_successful: true,
    metadata: {
      request_source: auth.requestSource ?? "api",
      ...metadata,
    },
  });
}

async function executeFirecrawlBrowserCode(
  sessionId: string,
  code: string,
  options?: { language?: "bash" | "node" | "python"; timeoutSeconds?: number },
): Promise<FirecrawlBrowserExecuteResponse> {
  return firecrawlRequest<FirecrawlBrowserExecuteResponse>(
    `/v2/browser/${encodeURIComponent(sessionId)}/execute`,
    {
      body: JSON.stringify({
        code,
        language: options?.language ?? "node",
        timeout: options?.timeoutSeconds ?? DEFAULT_BROWSER_TIMEOUT_SECONDS,
      }),
      method: "POST",
    },
  );
}

async function readHostedBrowserPageState(
  sessionId: string,
): Promise<FirecrawlResolvedPageState | null> {
  const response = await executeFirecrawlBrowserCode(
    sessionId,
    `
const state = {
  title: await page.title(),
  url: page.url(),
};
JSON.stringify(state);
    `.trim(),
  );

  const payload = parseExecutionPayload(response.result ?? response.stdout);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const state = payload as Record<string, unknown>;
  return {
    title: typeof state.title === "string" ? state.title : "",
    url: typeof state.url === "string" ? state.url : "about:blank",
  };
}

async function readHostedBrowserSnapshot(sessionId: string): Promise<{ data: string }> {
  const response = await executeFirecrawlBrowserCode(
    sessionId,
    `
const data = await page.screenshot({ type: "png", encoding: "base64" });
data;
    `.trim(),
  );

  const payload = parseExecutionPayload(response.result ?? response.stdout);
  if (typeof payload !== "string" || payload.trim().length === 0) {
    throw new Error("Hosted browser returned an empty screenshot");
  }

  return { data: payload };
}

async function listFirecrawlBrowserSessions(): Promise<FirecrawlBrowserSession[]> {
  const response = await firecrawlRequest<FirecrawlBrowserListResponse>("/v2/browser", {
    method: "GET",
  });

  return Array.isArray(response.sessions)
    ? response.sessions.filter(
        (session): session is FirecrawlBrowserSession =>
          Boolean(session.id) && session.status !== "destroyed",
      )
    : [];
}

async function resolveAuthorizedFirecrawlBrowserSession(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<{
  access: HostedBrowserSessionAccess;
  session: FirecrawlBrowserSession;
}> {
  const access = await assertHostedBrowserSessionAccess(sessionId, auth);
  const sessions = await listFirecrawlBrowserSessions();
  const session = sessions.find((entry) => entry.id === sessionId);

  if (!session) {
    await removeHostedBrowserSessionAccess(sessionId, access.organizationId);
    throw new Error("Hosted browser session not found");
  }

  return { access, session };
}

async function loadAuthorizedHostedBrowserTab(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<{
  access: HostedBrowserSessionAccess;
  tab: HostedBrowserTab;
}> {
  const { access, session } = await resolveAuthorizedFirecrawlBrowserSession(sessionId, auth);
  const state = await readHostedBrowserPageState(sessionId).catch(() => null);

  return {
    access,
    tab: normalizeHostedBrowserTab(session, state),
  };
}

function buildCommandCode(command: HostedBrowserCommand): {
  code: string;
  language: "node";
  timeoutSeconds: number;
} {
  const timeoutSeconds = Math.max(
    1,
    Math.min(300, Math.ceil((command.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_SECONDS * 1000) / 1000)),
  );

  switch (command.subaction) {
    case "navigate":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.goto(${JSON.stringify(command.url ?? "")}, { waitUntil: "domcontentloaded" });
JSON.stringify({ title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "click":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.locator(${JSON.stringify(command.selector ?? "")}).first().click();
JSON.stringify({ clicked: true, title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "type":
      return {
        language: "node",
        timeoutSeconds,
        code: `
const locator = page.locator(${JSON.stringify(command.selector ?? "")}).first();
await locator.fill("");
await locator.type(${JSON.stringify(command.text ?? "")});
JSON.stringify({ typed: true, title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "press":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.keyboard.press(${JSON.stringify(command.key ?? "Enter")});
JSON.stringify({ pressed: ${JSON.stringify(command.key ?? "Enter")}, title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "scroll":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.evaluate((pixels) => window.scrollBy(0, pixels), ${Number.isFinite(command.pixels) ? command.pixels : 480});
JSON.stringify({ scrolled: true, title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "wait":
      return {
        language: "node",
        timeoutSeconds,
        code: command.selector?.trim()
          ? `
await page.waitForSelector(${JSON.stringify(command.selector)}, { timeout: ${timeoutSeconds * 1000} });
JSON.stringify({ waitedFor: ${JSON.stringify(command.selector)}, title: await page.title(), url: page.url() });
            `.trim()
          : `
await new Promise((resolve) => setTimeout(resolve, ${timeoutSeconds * 1000}));
JSON.stringify({ waitedMs: ${timeoutSeconds * 1000}, title: await page.title(), url: page.url() });
            `.trim(),
      };
    case "back":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
JSON.stringify({ title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "forward":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
JSON.stringify({ title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "reload":
      return {
        language: "node",
        timeoutSeconds,
        code: `
await page.reload({ waitUntil: "domcontentloaded" });
JSON.stringify({ title: await page.title(), url: page.url() });
        `.trim(),
      };
    case "get":
      return {
        language: "node",
        timeoutSeconds,
        code: `
const payload = await page.evaluate(() => ({
  text: document.body?.innerText?.slice(0, 16000) || "",
  title: document.title,
  url: location.href,
}));
JSON.stringify(payload);
        `.trim(),
      };
    case "state":
      return {
        language: "node",
        timeoutSeconds,
        code: `
JSON.stringify({
  title: await page.title(),
  url: page.url(),
  viewport: page.viewportSize(),
});
        `.trim(),
      };
    case "eval":
      return {
        language: "node",
        timeoutSeconds,
        code: command.script?.trim() || "null",
      };
  }
}

export async function listHostedBrowserSessions(
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserTab[]> {
  const organizationId = requireHostedBrowserOrganizationId(auth);
  const sessionIds = await getStoredOrganizationSessionIds(organizationId);
  const tabs = await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const { tab } = await loadAuthorizedHostedBrowserTab(sessionId, auth);
        return tab;
      } catch {
        await removeHostedBrowserSessionAccess(sessionId, organizationId);
        return null;
      }
    }),
  );
  const resolvedTabs = tabs.filter((entry): entry is HostedBrowserTab => entry !== null);

  await logHostedBrowserUsage(auth, {
    operation: "browser_list",
    sessions: resolvedTabs.length,
  }).catch(() => {});

  return resolvedTabs;
}

export async function getHostedBrowserSession(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserTab> {
  const { tab } = await loadAuthorizedHostedBrowserTab(sessionId, auth);
  await logHostedBrowserUsage(auth, {
    operation: "browser_get",
    sessionId,
  }).catch(() => {});
  return tab;
}

export async function createHostedBrowserSession(
  options: {
    activityTtl?: number;
    title?: string;
    ttl?: number;
    url?: string;
  },
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserTab> {
  requireHostedBrowserOrganizationId(auth);
  const created = await firecrawlRequest<FirecrawlBrowserCreateResponse>("/v2/browser", {
    body: JSON.stringify({
      activityTtl: options.activityTtl ?? DEFAULT_BROWSER_ACTIVITY_TTL_SECONDS,
      streamWebView: true,
      ttl: options.ttl ?? DEFAULT_BROWSER_TTL_SECONDS,
    }),
    method: "POST",
  });

  if (!created.id) {
    throw new Error("Firecrawl returned no browser session id");
  }

  await registerHostedBrowserSessionAccess(created.id, auth);
  try {
    if (options.url?.trim()) {
      await executeFirecrawlBrowserCode(
        created.id,
        `
await page.goto(${JSON.stringify(options.url.trim())}, { waitUntil: "domcontentloaded" });
JSON.stringify({ title: await page.title(), url: page.url() });
        `.trim(),
      );
    }

    const tab = await getHostedBrowserSession(created.id, auth);
    const titledTab =
      options.title?.trim() && options.title.trim().length > 0
        ? {
            ...tab,
            title: options.title.trim(),
          }
        : tab;

    await logHostedBrowserUsage(auth, {
      operation: "browser_create",
      sessionId: titledTab.id,
      url: titledTab.url,
    }).catch(() => {});

    return titledTab;
  } catch (error) {
    await removeHostedBrowserSessionAccess(created.id).catch(() => {});
    throw error;
  }
}

export async function navigateHostedBrowserSession(
  sessionId: string,
  url: string,
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserTab> {
  await assertHostedBrowserSessionAccess(sessionId, auth);
  await executeFirecrawlBrowserCode(
    sessionId,
    `
await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });
JSON.stringify({ title: await page.title(), url: page.url() });
    `.trim(),
  );

  const tab = await getHostedBrowserSession(sessionId, auth);
  await logHostedBrowserUsage(auth, {
    operation: "browser_navigate",
    sessionId,
    url,
  }).catch(() => {});
  return tab;
}

export async function deleteHostedBrowserSession(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<FirecrawlBrowserDeleteResponse> {
  const access = await assertHostedBrowserSessionAccess(sessionId, auth);
  const deleted = await firecrawlRequest<FirecrawlBrowserDeleteResponse>(
    `/v2/browser/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  );

  await removeHostedBrowserSessionAccess(sessionId, access.organizationId);

  await logHostedBrowserUsage(auth, {
    operation: "browser_delete",
    sessionId,
    creditsBilled: deleted.creditsBilled ?? null,
    sessionDurationMs: deleted.sessionDurationMs ?? null,
  }).catch(() => {});

  return deleted;
}

export async function getHostedBrowserSnapshot(
  sessionId: string,
  auth?: HostedBrowserAuthContext,
): Promise<{ data: string }> {
  await assertHostedBrowserSessionAccess(sessionId, auth);
  const snapshot = await readHostedBrowserSnapshot(sessionId);
  await logHostedBrowserUsage(auth, {
    operation: "browser_snapshot",
    sessionId,
  }).catch(() => {});
  return snapshot;
}

export async function executeHostedBrowserCommand(
  sessionId: string,
  command: HostedBrowserCommand,
  auth?: HostedBrowserAuthContext,
): Promise<HostedBrowserCommandResult> {
  await assertHostedBrowserSessionAccess(sessionId, auth);
  const plan = buildCommandCode(command);
  const executed = await executeFirecrawlBrowserCode(sessionId, plan.code, {
    language: plan.language,
    timeoutSeconds: plan.timeoutSeconds,
  });

  if (executed.error?.trim()) {
    throw new Error(executed.error.trim());
  }

  const output = parseExecutionPayload(executed.result ?? executed.stdout);
  const session = await getHostedBrowserSession(sessionId, auth);
  const snapshot =
    command.subaction === "state" || command.subaction === "get"
      ? undefined
      : await readHostedBrowserSnapshot(sessionId).catch(() => undefined);

  await logHostedBrowserUsage(auth, {
    operation: "browser_command",
    sessionId,
    subaction: command.subaction,
  }).catch(() => {});

  return {
    output,
    session,
    snapshot,
  };
}

export async function extractHostedPage(
  options: HostedExtractOptions,
  auth?: HostedBrowserAuthContext,
): Promise<HostedExtractResult> {
  const response = await firecrawlRequest<FirecrawlScrapeResponse>("/v2/scrape", {
    body: JSON.stringify({
      formats: options.formats ?? ["markdown"],
      maxAge: 0,
      onlyMainContent: options.onlyMainContent ?? true,
      timeout: options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
      url: options.url,
      waitFor: options.waitFor ?? DEFAULT_EXTRACT_WAIT_FOR_MS,
    }),
    method: "POST",
  });

  const data = response.data ?? {};
  const result: HostedExtractResult = {
    provider: "firecrawl",
    url: options.url,
    markdown: typeof data.markdown === "string" ? data.markdown : null,
    html: typeof data.html === "string" ? data.html : null,
    screenshot: typeof data.screenshot === "string" ? data.screenshot : null,
    links: Array.isArray(data.links)
      ? data.links.filter((value): value is string => typeof value === "string")
      : [],
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
  };

  await logHostedBrowserUsage(auth, {
    operation: "extract_page",
    url: options.url,
    formats: options.formats ?? ["markdown"],
  }).catch(() => {});

  return result;
}

export function logHostedBrowserFailure(
  operation: string,
  error: unknown,
  metadata?: Record<string, unknown>,
): void {
  logger.error("[Hosted Browser] Request failed", {
    operation,
    error: error instanceof Error ? error.message : String(error),
    ...metadata,
  });
}
