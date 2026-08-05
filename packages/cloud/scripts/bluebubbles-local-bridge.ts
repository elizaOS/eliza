#!/usr/bin/env bun

/**
 * Local BlueBubbles -> Eliza Cloud bridge.
 *
 * Run this on the Mac that has BlueBubbles + Messages access. Configure
 * BlueBubbles to POST webhooks to:
 *
 *   http://127.0.0.1:8795/webhooks/bluebubbles
 *
 * Required env:
 *   BLUEBUBBLES_GATEWAY_SECRET  shared with the Cloud Worker secret
 *
 * Optional env:
 *   BLUEBUBBLES_SERVER_URL      default http://127.0.0.1:1234
 *   BLUEBUBBLES_PASSWORD        default read from BlueBubbles config.db
 *   ELIZA_CLOUD_BLUEBUBBLES_URL default https://api.elizacloud.ai/api/webhooks/bluebubbles
 *   BLUEBUBBLES_BRIDGE_PORT     default 8795
 */

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type BlueBubblesSendMethod,
  outboundReadiness as computeOutboundReadiness,
  senderOptions as computeSenderOptions,
  type OutboundReadiness,
  recipientFromChatGuid,
  shortcutValidationMatches,
} from "./bluebubbles-local-bridge-readiness";

type BlueBubblesHandle = {
  address?: string | null;
  service?: string | null;
};

type BlueBubblesChat = {
  guid?: string | null;
  chatIdentifier?: string | null;
};

type BlueBubblesMessage = {
  guid?: string | null;
  text?: string | null;
  isFromMe?: boolean | null;
  handle?: BlueBubblesHandle | null;
  chats?: BlueBubblesChat[] | null;
  metadata?: Record<string, unknown> | null;
};

type BlueBubblesPayload = {
  type: string;
  data: BlueBubblesMessage;
};

type CloudReply = {
  success?: boolean;
  handled?: boolean;
  replyText?: string | null;
  reason?: string;
};

const FIRST_CONTACT_REPLY =
  "Hey, I'm Eliza. I set up private Eliza Cloud agents that can text, remember context, and work for you. Eliza Cloud is usage-based: your agent runs in a private cloud container and spends credits only as it works. New users get $5 free credit to try it. What should I call you?";

type PendingReply = {
  id: string;
  chatGuid: string;
  text: string;
  sourceMessageId?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type BlueBubblesWebhook = {
  id: number;
  url: string;
  events: string;
  created: string;
};

type BlueBubblesConfigSnapshot = {
  enablePrivateApi?: string;
  enableFaceTimePrivateApi?: string;
  privateApiMode?: string;
};

type BlueBubblesServerInfo = {
  status?: number;
  message?: string;
  data?: {
    server_version?: string;
    private_api?: boolean;
    helper_connected?: boolean;
    detected_icloud?: string;
    detected_imessage?: string;
    proxy_service?: string;
  };
};

type AppleEventsProbe = {
  target: "Finder" | "System Events" | "Messages";
  ok: boolean;
  stdout?: string;
  error?: string;
};

type ShortcutsDiagnostics = {
  nativeCliPath: string;
  homebrewCliPath?: string;
  available: boolean;
  shortcutCount?: number;
  shortcuts?: string[];
  shortcutIdentifiers?: Record<string, string>;
  error?: string;
  validation?: {
    required: boolean;
    validated: boolean;
    detail?: string;
  };
};

type RetryPendingRepliesResult = {
  sent: string[];
  remaining: number;
  failed: Array<{ id: string; error: string }>;
  skipped?: string;
};

type ShortcutInputSnapshot = {
  fileName: string;
  path: string;
  size: number;
  modifiedAt: string;
};

type OutboundValidationRecord = {
  validatedAt: string;
  method: BlueBubblesSendMethod;
  shortcutName?: string;
  shortcutId?: string;
  recipient: string;
  messagePreview: string;
};

type ValidateOutboundRequest = {
  recipient?: string;
  chatGuid?: string;
  message?: string;
  method?: BlueBubblesSendMethod;
};

const port = Number.parseInt(process.env.BLUEBUBBLES_BRIDGE_PORT ?? "8795", 10);
const blueBubblesServerUrl = (
  process.env.BLUEBUBBLES_SERVER_URL ?? "http://127.0.0.1:1234"
).replace(/\/$/, "");
const cloudWebhookUrl =
  process.env.ELIZA_CLOUD_BLUEBUBBLES_URL ??
  "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles";
const gatewaySecret = process.env.BLUEBUBBLES_GATEWAY_SECRET ?? "";
const gatewayPhoneNumber = (
  process.env.BLUEBUBBLES_GATEWAY_PHONE_NUMBER ?? "+14159611510"
).trim();
const gatewayPhoneLabel = (
  process.env.BLUEBUBBLES_GATEWAY_PHONE_LABEL ??
  `Eliza Cloud Gateway (${gatewayPhoneNumber})`
).trim();
const blueBubblesSendMethod = readSendMethod();
const blueBubblesSendTimeoutMs = Number.parseInt(
  process.env.BLUEBUBBLES_SEND_TIMEOUT_MS ?? "45000",
  10,
);
const blueBubblesAutoStart =
  process.env.BLUEBUBBLES_AUTO_START !== "false" &&
  process.platform === "darwin";
const shortcutsSendShortcutName = (
  process.env.BLUEBUBBLES_SHORTCUT_NAME ?? "Eliza Cloud Send Message Ready"
).trim();
const shortcutsSendShortcutId =
  process.env.BLUEBUBBLES_SHORTCUT_ID?.trim() || null;
const shortcutsRunTarget = shortcutsSendShortcutId ?? shortcutsSendShortcutName;
const shortcutsInputDir =
  process.env.BLUEBUBBLES_SHORTCUT_INPUT_DIR ??
  join(process.cwd(), ".eliza-local/bluebubbles-shortcut-inputs");
const outboundValidationPath =
  process.env.BLUEBUBBLES_OUTBOUND_VALIDATION_PATH ??
  join(process.cwd(), ".eliza-local/bluebubbles-outbound-validation.json");
const outboundValidationRequired =
  process.env.BLUEBUBBLES_OUTBOUND_VALIDATION_REQUIRED !== "false";
const pendingReplyRetryEnabled =
  process.env.BLUEBUBBLES_PENDING_RETRY_ENABLED === "true";
const pendingReplyRetryIntervalMs = Number.parseInt(
  process.env.BLUEBUBBLES_PENDING_RETRY_INTERVAL_MS ?? "300000",
  10,
);
const pendingReplyRetryLimit = Number.parseInt(
  process.env.BLUEBUBBLES_PENDING_RETRY_LIMIT ?? "1",
  10,
);
const pendingRepliesPath =
  process.env.BLUEBUBBLES_PENDING_REPLIES_PATH ??
  join(process.cwd(), ".eliza-local/bluebubbles-pending-replies.json");
const expectedBlueBubblesWebhookUrl = `http://127.0.0.1:${port}/webhooks/bluebubbles`;
const processedMessageIds = new Set<string>();
const execFileAsync = promisify(execFile);
let retryInProgress = false;
let lastPendingRetry: {
  startedAt: string;
  finishedAt?: string;
  trigger: "manual" | "automatic";
  result?: RetryPendingRepliesResult;
} | null = null;
let lastBlueBubblesAutoStart: {
  attemptedAt: string;
  ok: boolean;
  detail: string;
} | null = null;
const shortcutsInputContract = {
  inputType: "json-file",
  requiredKeys: ["recipient", "message"],
  optionalKeys: ["chatGuid", "gatewayPhoneNumber", "gatewayPhoneLabel"],
  description:
    "Read Shortcut Input as a JSON file, parse JSON, send message to recipient, and finish without prompting.",
};

function readSendMethod(): BlueBubblesSendMethod {
  if (process.env.BLUEBUBBLES_SEND_METHOD === "private-api") {
    return "private-api";
  }
  if (process.env.BLUEBUBBLES_SEND_METHOD === "shortcuts") {
    return "shortcuts";
  }
  return "apple-script";
}

function readBlueBubblesPassword(): string {
  if (process.env.BLUEBUBBLES_PASSWORD) return process.env.BLUEBUBBLES_PASSWORD;

  const dbPath = join(
    process.env.HOME ?? "",
    "Library/Application Support/bluebubbles-server/config.db",
  );
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ value: string }, []>(
        "select value from config where name = 'password' limit 1",
      )
      .get();
    return row?.value ?? "";
  } finally {
    db.close();
  }
}

const blueBubblesPassword = readBlueBubblesPassword();

function blueBubblesConfigDbPath(): string {
  return join(
    process.env.HOME ?? "",
    "Library/Application Support/bluebubbles-server/config.db",
  );
}

function readBlueBubblesWebhooks(): BlueBubblesWebhook[] {
  const db = new Database(blueBubblesConfigDbPath(), { readonly: true });
  try {
    return db
      .query<BlueBubblesWebhook, []>(
        "select id, url, events, created from webhook order by id",
      )
      .all();
  } finally {
    db.close();
  }
}

function readBlueBubblesQueueCount(): number {
  const db = new Database(blueBubblesConfigDbPath(), { readonly: true });
  try {
    const row = db
      .query<{ count: number }, []>("select count(*) as count from queue")
      .get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function readBlueBubblesConfigSnapshot(): BlueBubblesConfigSnapshot {
  const db = new Database(blueBubblesConfigDbPath(), { readonly: true });
  try {
    const rows = db
      .query<{ name: string; value: string }, []>(
        "select name, value from config where name in ('enable_private_api', 'enable_ft_private_api', 'private_api_mode')",
      )
      .all();
    const configs = new Map(rows.map((row) => [row.name, row.value]));
    return {
      enablePrivateApi: configs.get("enable_private_api"),
      enableFaceTimePrivateApi: configs.get("enable_ft_private_api"),
      privateApiMode: configs.get("private_api_mode"),
    };
  } finally {
    db.close();
  }
}

async function readSipStatus(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/csrutil", [
      "status",
    ]);
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const output = `${stdout}${stderr}`.trim();
      if (output) return output;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

async function runAppleEventsProbe(
  target: AppleEventsProbe["target"],
  script: string,
): Promise<AppleEventsProbe> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 3_000 },
    );
    return {
      target,
      ok: true,
      stdout: `${stdout}${stderr}`.trim(),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
    const details = commandErrorMessage(error);
    const timedOut =
      error &&
      typeof error === "object" &&
      "signal" in error &&
      String((error as { signal?: unknown }).signal ?? "") === "SIGTERM";
    const errorParts = timedOut
      ? [`${target} AppleEvents probe timed out after 3000ms`, details]
      : [message, details];
    return {
      target,
      ok: false,
      error: errorParts
        .filter(Boolean)
        .filter((item, index, items) => items.indexOf(item) === index)
        .join("; "),
    };
  }
}

async function readAppleEventsDiagnostics(): Promise<AppleEventsProbe[]> {
  return Promise.all([
    runAppleEventsProbe("Finder", 'tell application "Finder" to get name'),
    runAppleEventsProbe(
      "System Events",
      'tell application "System Events" to count processes',
    ),
    runAppleEventsProbe(
      "Messages",
      'tell application "Messages" to get name of accounts',
    ),
  ]);
}

async function readShortcutsDiagnostics(): Promise<ShortcutsDiagnostics> {
  const nativeCliPath = "/usr/bin/shortcuts";
  const homebrewCliPath = "/opt/homebrew/bin/shortcuts";
  const validationRecord = await readOutboundValidation();
  const validation = {
    required: outboundValidationRequired,
    validated: shortcutValidationMatches({
      record: validationRecord,
      shortcutsSendShortcutName,
      shortcutsSendShortcutId,
    }),
    detail: validationRecord
      ? `last ${validationRecord.method} validation at ${validationRecord.validatedAt}`
      : "no successful validation send recorded",
  };

  try {
    const [{ stdout }, identifiersResult] = await Promise.all([
      execFileAsync(nativeCliPath, ["list"], {
        timeout: 5_000,
      }),
      execFileAsync(nativeCliPath, ["list", "--show-identifiers"], {
        timeout: 5_000,
      }).catch(() => null),
    ]);
    const shortcutIdentifiers: Record<string, string> = {};
    for (const line of identifiersResult?.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean) ?? []) {
      const match = /^(.*) \(([0-9A-F-]{36})\)$/.exec(line);
      if (match) shortcutIdentifiers[match[1]] = match[2];
    }
    const shortcuts = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      nativeCliPath,
      homebrewCliPath,
      available: true,
      shortcutCount: shortcuts.length,
      shortcuts,
      shortcutIdentifiers,
      validation,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
    return {
      nativeCliPath,
      homebrewCliPath,
      available: false,
      error: message,
      validation,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlueBubblesConnectionError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${(error as { cause?: unknown }).cause ?? ""}`
      : String(error);
  return /\bECONNREFUSED\b|\bfetch failed\b|Unable to connect|connection refused/i.test(
    text,
  );
}

async function tryAutoStartBlueBubbles(): Promise<void> {
  if (!blueBubblesAutoStart) return;
  try {
    await execFileAsync("open", ["-a", "BlueBubbles"], { timeout: 5_000 });
    lastBlueBubblesAutoStart = {
      attemptedAt: new Date().toISOString(),
      ok: true,
      detail: "open -a BlueBubbles completed",
    };
  } catch (error) {
    lastBlueBubblesAutoStart = {
      attemptedAt: new Date().toISOString(),
      ok: false,
      detail: commandErrorMessage(error),
    };
  }
}

async function readBlueBubblesServerInfo(): Promise<
  BlueBubblesServerInfo | { error: string }
> {
  if (!blueBubblesPassword) {
    return { error: "BlueBubbles password is not configured" };
  }

  const url = new URL("/api/v1/server/info", blueBubblesServerUrl);
  url.searchParams.set("password", blueBubblesPassword);
  let firstError: unknown = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    return text
      ? (JSON.parse(text) as BlueBubblesServerInfo)
      : { status: response.status };
  } catch (error) {
    firstError = error;
  }

  if (isBlueBubblesConnectionError(firstError)) {
    await tryAutoStartBlueBubbles();
    await sleep(2_000);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const text = await response.text();
      return text
        ? (JSON.parse(text) as BlueBubblesServerInfo)
        : { status: response.status };
    } catch (retryError) {
      return {
        error: `BlueBubbles server unavailable after auto-start: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      };
    }
  }

  return {
    error:
      firstError instanceof Error ? firstError.message : String(firstError),
  };
}

function blueBubblesAutoStartSnapshot(): Record<string, unknown> {
  return {
    enabled: blueBubblesAutoStart,
    last: lastBlueBubblesAutoStart,
  };
}

function hasServerInfoData(
  serverInfo: BlueBubblesServerInfo | { error: string },
): serverInfo is BlueBubblesServerInfo {
  return !("error" in serverInfo) && Boolean(serverInfo.data);
}

function outboundReadiness(args: {
  serverInfo: BlueBubblesServerInfo | { error: string };
  sipStatus: string;
  pendingReplies: PendingReply[];
  appleEvents?: AppleEventsProbe[];
  shortcuts?: ShortcutsDiagnostics;
  method?: BlueBubblesSendMethod;
}): OutboundReadiness {
  return computeOutboundReadiness({
    ...args,
    method: args.method ?? blueBubblesSendMethod,
    hasBlueBubblesPassword: Boolean(blueBubblesPassword),
    shortcutsSendShortcutName,
    shortcutsSendShortcutId: shortcutsSendShortcutId ?? undefined,
  });
}

function senderOptions(args: {
  serverInfo: BlueBubblesServerInfo | { error: string };
  sipStatus: string;
  pendingReplies: PendingReply[];
  appleEvents?: AppleEventsProbe[];
  shortcuts?: ShortcutsDiagnostics;
}): OutboundReadiness[] {
  return computeSenderOptions({
    ...args,
    hasBlueBubblesPassword: Boolean(blueBubblesPassword),
    shortcutsSendShortcutName,
    shortcutsSendShortcutId: shortcutsSendShortcutId ?? undefined,
  });
}

async function readPendingReplies(): Promise<PendingReply[]> {
  try {
    const text = await readFile(pendingRepliesPath, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as PendingReply[]) : [];
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function readOutboundValidation(): Promise<OutboundValidationRecord | null> {
  try {
    return JSON.parse(
      await readFile(outboundValidationPath, "utf8"),
    ) as OutboundValidationRecord;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function writeOutboundValidation(
  record: OutboundValidationRecord,
): Promise<void> {
  await mkdir(dirname(outboundValidationPath), { recursive: true });
  await writeFile(
    outboundValidationPath,
    `${JSON.stringify(record, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

async function writePendingReplies(replies: PendingReply[]): Promise<void> {
  await mkdir(dirname(pendingRepliesPath), { recursive: true });
  await writeFile(pendingRepliesPath, `${JSON.stringify(replies, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function pendingReplyCount(): Promise<number> {
  return (await readPendingReplies()).length;
}

async function readRecentShortcutInputs(
  limit = 5,
): Promise<ShortcutInputSnapshot[]> {
  try {
    const entries = await readdir(shortcutsInputDir, { withFileTypes: true });
    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const path = join(shortcutsInputDir, entry.name);
          const stats = await stat(path);
          return {
            fileName: entry.name,
            path,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        }),
    );
    return snapshots
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, limit);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function enqueuePendingReply(args: {
  chatGuid: string;
  text: string;
  sourceMessageId?: string;
  error: string;
}): Promise<PendingReply> {
  const replies = await readPendingReplies();
  const existing =
    args.sourceMessageId &&
    replies.find((reply) => reply.sourceMessageId === args.sourceMessageId);
  const now = new Date().toISOString();

  if (existing) {
    existing.lastError = args.error;
    existing.updatedAt = now;
    await writePendingReplies(replies);
    return existing;
  }

  const reply: PendingReply = {
    id: crypto.randomUUID(),
    chatGuid: args.chatGuid,
    text: args.text,
    sourceMessageId: args.sourceMessageId,
    attempts: 0,
    lastError: args.error,
    createdAt: now,
    updatedAt: now,
  };
  replies.push(reply);
  await writePendingReplies(replies);
  return reply;
}

async function retryPendingReplies(
  limit = 10,
  trigger: "manual" | "automatic" = "manual",
): Promise<RetryPendingRepliesResult> {
  if (limit <= 0) {
    return {
      sent: [],
      remaining: await pendingReplyCount(),
      failed: [],
      skipped: "limit_not_positive",
    };
  }

  if (retryInProgress) {
    return {
      sent: [],
      remaining: await pendingReplyCount(),
      failed: [],
      skipped: "retry_in_progress",
    };
  }

  const replies = await readPendingReplies();
  if (replies.length === 0) {
    return {
      sent: [],
      remaining: 0,
      failed: [],
    };
  }

  const sent = new Set<string>();
  const failed: Array<{ id: string; error: string }> = [];
  retryInProgress = true;
  lastPendingRetry = {
    startedAt: new Date().toISOString(),
    trigger,
  };

  try {
    for (const reply of replies.slice(0, limit)) {
      try {
        await sendBlueBubblesReply(reply.chatGuid, reply.text);
        sent.add(reply.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.attempts += 1;
        reply.lastError = message;
        reply.updatedAt = new Date().toISOString();
        failed.push({ id: reply.id, error: message });
      }
    }

    const remainingReplies = replies.filter((reply) => !sent.has(reply.id));
    await writePendingReplies(remainingReplies);

    const result = {
      sent: [...sent],
      remaining: remainingReplies.length,
      failed,
    };
    lastPendingRetry = {
      ...(lastPendingRetry ?? {
        startedAt: new Date().toISOString(),
        trigger,
      }),
      finishedAt: new Date().toISOString(),
      result,
    };
    return result;
  } finally {
    retryInProgress = false;
  }
}

async function gatewayDiagnostics(): Promise<Record<string, unknown>> {
  const webhooks = readBlueBubblesWebhooks();
  const expectedWebhook = webhooks.find(
    (webhook) => webhook.url === expectedBlueBubblesWebhookUrl,
  );
  const pendingReplies = await readPendingReplies();
  const recentShortcutInputs = await readRecentShortcutInputs();
  const [serverInfo, sipStatus, appleEvents, shortcuts] = await Promise.all([
    readBlueBubblesServerInfo(),
    readSipStatus(),
    readAppleEventsDiagnostics(),
    readShortcutsDiagnostics(),
  ]);

  return {
    senderOptions: senderOptions({
      serverInfo,
      sipStatus,
      pendingReplies,
      appleEvents,
      shortcuts,
    }),
    bridge: {
      status: "ok",
      blueBubblesServerUrl,
      cloudWebhookUrl,
      sendMethod: blueBubblesSendMethod,
      sendTimeoutMs: blueBubblesSendTimeoutMs,
      shortcutsSendShortcutName,
      shortcutsSendShortcutId,
      shortcutsRunTarget,
      shortcutsInputContract,
      shortcutsInputDir,
      recentShortcutInputs,
      outboundValidationPath,
      gatewayPhoneNumber,
      gatewayPhoneLabel,
      pendingRepliesPath,
      pendingReplyCount: pendingReplies.length,
      pendingReplyRetry: {
        enabled: pendingReplyRetryEnabled,
        intervalMs: pendingReplyRetryIntervalMs,
        limit: pendingReplyRetryLimit,
        inProgress: retryInProgress,
        last: lastPendingRetry,
      },
      outboundReadiness: outboundReadiness({
        serverInfo,
        sipStatus,
        pendingReplies,
        appleEvents,
        shortcuts,
      }),
    },
    blueBubbles: {
      serverInfo,
      autoStart: blueBubblesAutoStartSnapshot(),
      config: readBlueBubblesConfigSnapshot(),
      webhooks,
      queueCount: readBlueBubblesQueueCount(),
      expectedWebhookUrl: expectedBlueBubblesWebhookUrl,
      expectedWebhookConfigured: Boolean(expectedWebhook),
      expectedWebhookEvents: expectedWebhook
        ? JSON.parse(expectedWebhook.events)
        : null,
    },
    macos: {
      sipStatus,
      appleEvents,
      shortcuts,
    },
  };
}

type DoctorCheck = {
  name: string;
  status: "pass" | "blocked";
  detail: string;
};

async function gatewayDoctor(): Promise<{
  status: "ready" | "blocked";
  checks: DoctorCheck[];
  next: string[];
}> {
  const diagnostics = await gatewayDiagnostics();
  const senderOptionsSummary = diagnostics.senderOptions as
    | OutboundReadiness[]
    | undefined;
  const bridge = (diagnostics.bridge ?? {}) as {
    status?: string;
    outboundReadiness?: {
      ready?: boolean;
      method?: string;
      reasons?: string[];
    };
    pendingReplyCount?: number;
    recentShortcutInputs?: ShortcutInputSnapshot[];
    hasGatewaySecret?: boolean;
    hasBlueBubblesPassword?: boolean;
  };
  const blueBubbles = (diagnostics.blueBubbles ?? {}) as {
    serverInfo?: BlueBubblesServerInfo | { error: string };
    config?: BlueBubblesConfigSnapshot;
    expectedWebhookConfigured?: boolean;
    expectedWebhookEvents?: string[] | null;
  };
  const macos = (diagnostics.macos ?? {}) as {
    sipStatus?: string;
    appleEvents?: AppleEventsProbe[];
    shortcuts?: ShortcutsDiagnostics;
  };

  const serverInfo = blueBubbles.serverInfo ?? {
    error: "server info unavailable",
  };
  const serverInfoReady = hasServerInfoData(serverInfo ?? {});
  const outbound = bridge.outboundReadiness;
  const webhookEvents = blueBubbles.expectedWebhookEvents ?? [];
  const checks: DoctorCheck[] = [
    {
      name: "bridge",
      status: bridge.status === "ok" ? "pass" : "blocked",
      detail: `local bridge status=${bridge.status ?? "unknown"}`,
    },
    {
      name: "cloud-secret",
      status: gatewaySecret ? "pass" : "blocked",
      detail: gatewaySecret
        ? "configured"
        : "BLUEBUBBLES_GATEWAY_SECRET missing",
    },
    {
      name: "bluebubbles-server",
      status: serverInfoReady ? "pass" : "blocked",
      detail: serverInfoReady
        ? `server=${serverInfo.data?.server_version ?? "unknown"}`
        : serverInfo && "error" in serverInfo
          ? serverInfo.error
          : "server info unavailable",
    },
    {
      name: "inbound-webhook",
      status:
        blueBubbles.expectedWebhookConfigured &&
        webhookEvents.includes("new-message")
          ? "pass"
          : "blocked",
      detail: blueBubbles.expectedWebhookConfigured
        ? `events=${webhookEvents.join(",") || "none"}`
        : `missing ${expectedBlueBubblesWebhookUrl}`,
    },
    {
      name: "outbound",
      status: outbound?.ready ? "pass" : "blocked",
      detail: outbound?.ready
        ? `${outbound.method ?? blueBubblesSendMethod} ready`
        : [
            ...(outbound?.reasons ?? ["outbound readiness unavailable"]),
            blueBubbles.config?.enablePrivateApi ||
            blueBubbles.config?.privateApiMode
              ? `BlueBubbles config private_api=${blueBubbles.config?.enablePrivateApi ?? "unknown"} mode=${blueBubbles.config?.privateApiMode ?? "unknown"}`
              : null,
          ]
            .filter(Boolean)
            .join("; "),
    },
    {
      name: "pending-replies",
      status: (bridge.pendingReplyCount ?? 0) === 0 ? "pass" : "blocked",
      detail: `${bridge.pendingReplyCount ?? 0} pending`,
    },
  ];

  const next: string[] = [];
  if (!outbound?.ready) {
    const readyAlternates =
      senderOptionsSummary
        ?.filter(
          (option) => option.ready && option.method !== blueBubblesSendMethod,
        )
        .map((option) => option.method) ?? [];
    if (readyAlternates.length > 0) {
      next.push(
        `Ready alternate sender(s): ${readyAlternates.join(", ")}. Set BLUEBUBBLES_SEND_METHOD and restart the bridge.`,
      );
    }
    if (blueBubblesSendMethod === "apple-script") {
      next.push(
        "Restore Messages AppleEvents/Automation access for the bridge, or switch BLUEBUBBLES_SEND_METHOD to a ready sender.",
      );
    } else if (blueBubblesSendMethod === "private-api") {
      next.push(
        "Connect the BlueBubbles private API helper and disable SIP for private-api mode.",
      );
    } else if (blueBubblesSendMethod === "shortcuts") {
      const shortcutInstalled = macos.shortcuts?.shortcuts?.includes(
        shortcutsSendShortcutName,
      );
      const shortcutIdInstalled =
        shortcutsSendShortcutId &&
        Object.values(macos.shortcuts?.shortcutIdentifiers ?? {}).includes(
          shortcutsSendShortcutId,
        );
      if (shortcutsSendShortcutId && !shortcutIdInstalled) {
        next.push(
          `Install a Shortcut with id "${shortcutsSendShortcutId}" that reads JSON input keys ${shortcutsInputContract.requiredKeys.join(", ")} and sends without prompting.`,
        );
      } else if (!shortcutsSendShortcutId && !shortcutInstalled) {
        next.push(
          `Install a Shortcut named "${shortcutsSendShortcutName}" that reads JSON input keys ${shortcutsInputContract.requiredKeys.join(", ")} and sends without prompting.`,
        );
      } else {
        next.push(
          `Run bun run --cwd packages/app-core sms-gateway:validate:bluebubbles -- --confirm-real-send successfully; Shortcut "${shortcutsRunTarget}" is installed but has not completed a real send validation.`,
        );
      }
      if (bridge.recentShortcutInputs?.length) {
        next.push(
          `Latest preserved Shortcut input: ${bridge.recentShortcutInputs[0].path}`,
        );
      }
      const messagesProbe = macos.appleEvents?.find(
        (probe) => probe.target === "Messages",
      );
      if (messagesProbe && !messagesProbe.ok) {
        next.push(
          `Messages automation is currently unavailable: ${messagesProbe.error ?? "unknown error"}`,
        );
      }
    }
  }
  if ((bridge.pendingReplyCount ?? 0) > 0) {
    next.push("Do not retry pending replies until outbound status is pass.");
  }
  if (!serverInfoReady) {
    next.push("Start BlueBubbles and confirm the local server is reachable.");
  }
  if (macos.sipStatus && blueBubblesSendMethod === "private-api") {
    next.push(`Current SIP status: ${macos.sipStatus}`);
  }
  if (macos.shortcuts && blueBubblesSendMethod === "shortcuts") {
    next.push(`Installed Shortcuts: ${macos.shortcuts.shortcutCount ?? 0}`);
  }

  return {
    status: checks.every((check) => check.status === "pass")
      ? "ready"
      : "blocked",
    checks,
    next,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function chatGuidFor(payload: BlueBubblesPayload): string | null {
  const chatGuid = payload.data.chats?.[0]?.guid?.trim();
  if (chatGuid) return normalizeChatGuid(chatGuid, payload);

  const sender =
    payload.data.handle?.address?.trim() ??
    payload.data.chats?.[0]?.chatIdentifier?.trim();
  return sender ? `${messageServiceFor(payload)};-;${sender}` : null;
}

function messageServiceFor(payload: BlueBubblesPayload): "iMessage" | "SMS" {
  const service = payload.data.handle?.service?.trim().toLowerCase();
  return service === "sms" ? "SMS" : "iMessage";
}

function normalizeChatGuid(
  chatGuid: string,
  payload: BlueBubblesPayload,
): string {
  if (!chatGuid.startsWith("any;-;")) return chatGuid;
  return `${messageServiceFor(payload)};-;${chatGuid.slice("any;-;".length)}`;
}

function hasPreferredNameSignal(text: string): boolean {
  return /\b(?:my name is|i am|i'm|call me)\s+[a-z][a-z .'-]{1,40}\b/i.test(
    text,
  );
}

function replyTextForCloudReply(
  reply: CloudReply,
  payload: BlueBubblesPayload,
): string | null {
  if (
    reply.reason === "unknown_owner" &&
    !hasPreferredNameSignal(payload.data.text?.trim() ?? "")
  ) {
    return FIRST_CONTACT_REPLY;
  }

  return reply.replyText?.trim() || null;
}

async function sendBlueBubblesReply(
  chatGuid: string,
  text: string,
  method: BlueBubblesSendMethod = blueBubblesSendMethod,
): Promise<void> {
  if (method === "shortcuts") {
    await sendShortcutsReply(chatGuid, text);
    return;
  }
  if (!blueBubblesPassword) {
    throw new Error("BlueBubbles password is not configured");
  }

  const url = new URL("/api/v1/message/text", blueBubblesServerUrl);
  url.searchParams.set("password", blueBubblesPassword);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    blueBubblesSendTimeoutMs,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        message: text,
        method,
        tempGuid: `eliza-cloud-${crypto.randomUUID()}`,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `BlueBubbles send timed out after ${blueBubblesSendTimeoutMs}ms using ${method}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `BlueBubbles send failed (${response.status}): ${await response.text()}`,
    );
  }
}

async function sendShortcutsReply(
  chatGuid: string,
  text: string,
): Promise<void> {
  await mkdir(shortcutsInputDir, { recursive: true });
  const inputPath = join(
    shortcutsInputDir,
    `message-${Date.now()}-${crypto.randomUUID()}.json`,
  );
  let preserveInput = false;
  try {
    await writeFile(
      inputPath,
      `${JSON.stringify({
        chatGuid,
        recipient: recipientFromChatGuid(chatGuid),
        message: text,
        gatewayPhoneNumber,
        gatewayPhoneLabel,
      })}\n`,
      { mode: 0o600 },
    );
    await execFileAsync(
      "/usr/bin/shortcuts",
      ["run", shortcutsRunTarget, "--input-path", inputPath],
      { timeout: blueBubblesSendTimeoutMs },
    );
  } catch (error) {
    preserveInput = true;
    throw new Error(
      `Shortcuts send failed using "${shortcutsRunTarget}" with input ${inputPath}: ${commandErrorMessage(error)}`,
    );
  } finally {
    if (!preserveInput) {
      await rm(inputPath, { force: true });
    }
  }
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const base =
    error instanceof Error
      ? error.message
      : "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  const details: string[] = [];
  for (const key of ["code", "signal", "stdout", "stderr"] as const) {
    if (key in error) {
      const value = (error as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        details.push(`${key}=${String(value).trim()}`);
      }
    }
  }
  return details.length > 0 ? `${base}; ${details.join("; ")}` : base;
}

async function forwardToCloud(
  payload: BlueBubblesPayload,
): Promise<CloudReply> {
  const forwardedPayload = stampGatewayIdentity(payload);
  const response = await fetch(cloudWebhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-eliza-bridge": "bluebubbles",
      "x-eliza-gateway-secret": gatewaySecret,
    },
    body: JSON.stringify(forwardedPayload),
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as CloudReply) : {};
  if (!response.ok) {
    throw new Error(`Cloud webhook failed (${response.status}): ${text}`);
  }
  return body;
}

function stampGatewayIdentity(payload: BlueBubblesPayload): BlueBubblesPayload {
  return {
    ...payload,
    data: {
      ...payload.data,
      metadata: {
        ...(payload.data.metadata ?? {}),
        localPhoneNumber: gatewayPhoneNumber,
        phoneNumber: gatewayPhoneNumber,
        phoneAccountId: gatewayPhoneNumber,
        phoneAccountLabel: gatewayPhoneLabel,
      },
    },
  };
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gatewaySecret) {
    json(res, 500, { error: "BLUEBUBBLES_GATEWAY_SECRET is required" });
    return;
  }
  if (blueBubblesSendMethod !== "shortcuts" && !blueBubblesPassword) {
    json(res, 500, { error: "BlueBubbles password is not configured" });
    return;
  }

  const rawBody = await readBody(req);
  const payload = JSON.parse(rawBody) as BlueBubblesPayload;

  const messageId = payload.data?.guid;
  if (messageId && processedMessageIds.has(messageId)) {
    json(res, 200, { success: true, skipped: "duplicate" });
    return;
  }
  if (messageId) processedMessageIds.add(messageId);

  const reply = await forwardToCloud(payload);
  const replyText = replyTextForCloudReply(reply, payload);
  const chatGuid = chatGuidFor(payload);
  let sendError: string | undefined;
  let queuedReplyId: string | undefined;

  if (replyText && chatGuid) {
    try {
      await sendBlueBubblesReply(chatGuid, replyText);
    } catch (error) {
      sendError = error instanceof Error ? error.message : String(error);
      const pending = await enqueuePendingReply({
        chatGuid,
        text: replyText,
        sourceMessageId: messageId ?? undefined,
        error: sendError,
      });
      queuedReplyId = pending.id;
      console.error(
        "[bluebubbles-local-bridge] queued reply after send failure",
        {
          queuedReplyId,
          chatGuid,
          sourceMessageId: messageId,
          error: sendError,
        },
      );
    }
  }

  json(res, 200, {
    success: true,
    handled: reply.handled,
    reason: reply.reason,
    replied: Boolean(replyText && chatGuid && !sendError),
    replyQueued: Boolean(queuedReplyId),
    queuedReplyId,
    sendError,
  });
}

function chatGuidForOutboundValidation(input: ValidateOutboundRequest): string {
  const chatGuid = input.chatGuid?.trim();
  if (chatGuid) return chatGuid;

  const recipient = input.recipient?.trim();
  if (!recipient) {
    throw new Error("recipient or chatGuid is required");
  }

  const service = recipient.includes("@") ? "iMessage" : "SMS";
  return `${service};-;${recipient}`;
}

async function validateOutboundSend(
  input: ValidateOutboundRequest,
): Promise<OutboundValidationRecord> {
  const message = input.message?.trim();
  if (!message) {
    throw new Error("message is required");
  }

  const chatGuid = chatGuidForOutboundValidation(input);
  const recipient = recipientFromChatGuid(chatGuid) ?? input.recipient?.trim();
  if (!recipient) {
    throw new Error("recipient could not be derived from chatGuid");
  }

  const method = input.method ?? blueBubblesSendMethod;
  if (
    !(["apple-script", "private-api", "shortcuts"] as const).includes(method)
  ) {
    throw new Error(`unsupported outbound validation method: ${method}`);
  }

  await sendBlueBubblesReply(chatGuid, message, method);
  const record: OutboundValidationRecord = {
    validatedAt: new Date().toISOString(),
    method,
    shortcutName:
      method === "shortcuts" ? shortcutsSendShortcutName : undefined,
    shortcutId:
      method === "shortcuts"
        ? (shortcutsSendShortcutId ?? undefined)
        : undefined,
    recipient,
    messagePreview:
      message.length > 160 ? `${message.slice(0, 157)}...` : message,
  };
  await writeOutboundValidation(record);
  return record;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );

  if (req.method === "GET" && url.pathname === "/health") {
    const pendingReplies = await readPendingReplies();
    const recentShortcutInputs = await readRecentShortcutInputs();
    const [serverInfo, sipStatus, appleEvents, shortcuts] = await Promise.all([
      readBlueBubblesServerInfo(),
      readSipStatus(),
      readAppleEventsDiagnostics(),
      readShortcutsDiagnostics(),
    ]);
    json(res, 200, {
      status: "ok",
      blueBubblesServerUrl,
      cloudWebhookUrl,
      hasGatewaySecret: Boolean(gatewaySecret),
      hasBlueBubblesPassword: Boolean(blueBubblesPassword),
      sendMethod: blueBubblesSendMethod,
      sendTimeoutMs: blueBubblesSendTimeoutMs,
      blueBubblesAutoStart: blueBubblesAutoStartSnapshot(),
      shortcutsSendShortcutName,
      shortcutsSendShortcutId,
      shortcutsRunTarget,
      shortcutsInputContract,
      shortcutsInputDir,
      recentShortcutInputs,
      outboundValidationPath,
      gatewayPhoneNumber,
      gatewayPhoneLabel,
      pendingRepliesPath,
      pendingReplyCount: pendingReplies.length,
      pendingReplyRetry: {
        enabled: pendingReplyRetryEnabled,
        intervalMs: pendingReplyRetryIntervalMs,
        limit: pendingReplyRetryLimit,
        inProgress: retryInProgress,
        last: lastPendingRetry,
      },
      outboundReadiness: outboundReadiness({
        serverInfo,
        sipStatus,
        pendingReplies,
        appleEvents,
        shortcuts,
      }),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pending-replies") {
    const replies = await readPendingReplies();
    json(res, 200, {
      count: replies.length,
      replies: replies.map((reply) => ({
        id: reply.id,
        chatGuid: reply.chatGuid,
        sourceMessageId: reply.sourceMessageId,
        attempts: reply.attempts,
        lastError: reply.lastError,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        textPreview:
          reply.text.length > 160
            ? `${reply.text.slice(0, 157)}...`
            : reply.text,
      })),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/diagnostics") {
    json(res, 200, await gatewayDiagnostics());
    return;
  }

  if (req.method === "GET" && url.pathname === "/doctor") {
    json(res, 200, await gatewayDoctor());
    return;
  }

  if (req.method === "POST" && url.pathname === "/pending-replies/retry") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
    json(res, 200, await retryPendingReplies(limit, "manual"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/outbound/validate") {
    const input = JSON.parse(await readBody(req)) as ValidateOutboundRequest;
    json(res, 200, { ok: true, validation: await validateOutboundSend(input) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhooks/bluebubbles") {
    await handleWebhook(req, res);
    return;
  }

  json(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[bluebubbles-local-bridge]", error);
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

function startPendingReplyRetryLoop(): void {
  if (!pendingReplyRetryEnabled || pendingReplyRetryIntervalMs <= 0) return;

  const interval = Math.max(
    pendingReplyRetryIntervalMs,
    blueBubblesSendTimeoutMs + 5_000,
  );
  const timer = setInterval(() => {
    retryPendingReplies(pendingReplyRetryLimit, "automatic").catch((error) => {
      console.error(
        "[bluebubbles-local-bridge] automatic pending reply retry failed",
        error,
      );
    });
  }, interval);
  timer.unref?.();

  console.log(
    `[bluebubbles-local-bridge] pending reply retry enabled every ${interval}ms`,
  );
}

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[bluebubbles-local-bridge] listening on http://127.0.0.1:${port}`,
  );
  console.log(`[bluebubbles-local-bridge] forwarding to ${cloudWebhookUrl}`);
  startPendingReplyRetryLoop();
});
