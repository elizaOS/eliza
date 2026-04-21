import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Character,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { AutonomyService } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import googleGenAIPlugin from "@elizaos/plugin-google-genai";
import groqPlugin from "@elizaos/plugin-groq";
import XAIPlugin from "@elizaos/plugin-xai";
import sqlPlugin from "@elizaos/plugin-sql";
import polymarketPlugin from "@elizaos/plugin-polymarket";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import {
  applyEnvValues,
  loadEnvConfig,
  readEnvFile,
  resolveEnvPath,
  resolveLlmModel,
  resolveLlmProvider,
  writeEnvFile,
  type CliOptions,
  type EnvConfig,
  type LlmProvider,
} from "./lib";
import { runPolymarketTui, runSettingsWizard, setFatalError, type SettingsField } from "./tui";
import { runInkInputTest } from "./ink-input-test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ERROR_LOG_PATH = path.join(__dirname, "polymarket-error.log");

type RuntimeSession = {
  readonly runtime: AgentRuntime;
  readonly roomId: UUID;
  readonly worldId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly options: CliOptions;
  readonly config: EnvConfig;
};

type CharacterSettings = NonNullable<Character["settings"]>;

const DEFAULT_ROOM_ID = stringToUuid("polymarket-runtime-room");
const DEFAULT_WORLD_ID = stringToUuid("polymarket-runtime-world");
const DEFAULT_USER_ID = stringToUuid("polymarket-operator");
const POLYGON_CHAIN_ID = 137;
const PROVIDER_OPTIONS = ["openai", "anthropic", "gemini", "groq", "grok"] as const;
const DEFAULT_LLM_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-pro-preview-03-25",
  groq: "llama-3.3-70b-versatile",
  grok: "grok-3",
};

type EnvSnapshot = Record<string, string>;

type DerivedApiCreds = {
  readonly key?: string;
  readonly apiKey?: string;
  readonly secret: string;
  readonly passphrase: string;
};

type WriteCallback = (err?: Error | null) => void;
type WriteArgs = {
  encoding: BufferEncoding | undefined;
  callback: WriteCallback | undefined;
};

const wrappedStreams = new WeakSet<NodeJS.WriteStream>();

/**
 * Log an error to the error log file for debugging.
 * This persists errors even if the TUI crashes.
 */
function logErrorToFile(error: Error | string, context?: string): void {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error 
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  const logEntry = `[${timestamp}]${context ? ` [${context}]` : ""}\n${errorMessage}\n\n`;
  
  try {
    fs.appendFileSync(ERROR_LOG_PATH, logEntry);
  } catch {
    // If we can't write to the log file, there's nothing we can do
  }
}

/**
 * Display an error message after cleaning up the terminal.
 * This ensures errors are visible even when the TUI was active.
 */
function displayFatalError(error: Error | string, context?: string): void {
  // Reset terminal state
  if (process.stdout.isTTY) {
    // Disable mouse tracking and restore terminal
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1007l");
    // Clear any partial lines and move to a new line
    process.stdout.write("\n");
  }
  
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  
  console.error("\n" + "=".repeat(60));
  console.error("❌ FATAL ERROR" + (context ? ` [${context}]` : ""));
  console.error("=".repeat(60));
  console.error(errorMessage);
  if (stack) {
    console.error("\nStack trace:");
    console.error(stack);
  }
  console.error("=".repeat(60));
  console.error(`Error log saved to: ${ERROR_LOG_PATH}`);
  console.error("");
}

/**
 * Handle a fatal error: log it, notify the TUI, display it, and exit.
 */
function handleFatalError(error: Error | string, context?: string): void {
  logErrorToFile(error, context);
  
  // Try to notify the TUI first (if it's running)
  try {
    setFatalError(error instanceof Error ? error.message : String(error));
  } catch {
    // TUI might not be running, that's OK
  }
  
  // Give the TUI a moment to display the error, then force display and exit
  setTimeout(() => {
    displayFatalError(error, context);
    process.exit(1);
  }, 100);
}

/**
 * Install global error handlers for uncaught exceptions and unhandled rejections.
 * This ensures errors are always visible, even when the TUI is active.
 */
function installGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error) => {
    handleFatalError(error, "uncaughtException");
  });
  
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    handleFatalError(error, "unhandledRejection");
  });
}

// Install handlers immediately when this module loads
installGlobalErrorHandlers();

function normalizeWriteArgs(
  encoding: BufferEncoding | WriteCallback | undefined,
  callback?: WriteCallback
): WriteArgs {
  if (typeof encoding === "function") {
    return { encoding: undefined, callback: encoding };
  }
  return { encoding, callback };
}

function shouldFilterLogs(level: string): boolean {
  return ["warn", "error", "fatal"].includes(level);
}

function shouldDropLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(info|debug|trace)\b/i.test(trimmed);
}

function filterLines(text: string, pending: { value: string }): string {
  const combined = pending.value + text;
  const lines = combined.split("\n");
  const hasTrailingNewline = combined.endsWith("\n");
  pending.value = hasTrailingNewline ? "" : lines.pop() ?? "";

  const kept = lines.filter((line) => !shouldDropLine(line));
  if (kept.length === 0) {
    return "";
  }
  return kept.join("\n") + "\n";
}

function wrapWriteStream(stream: NodeJS.WriteStream): void {
  if (wrappedStreams.has(stream)) return;
  wrappedStreams.add(stream);
  const originalWrite = stream.write.bind(stream) as typeof stream.write;
  const pending = { value: "" };

  stream.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ): boolean => {
    const args = normalizeWriteArgs(encoding, callback);
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(args.encoding ?? "utf8");
    const filtered = filterLines(text, pending);
    if (filtered.length === 0) {
      if (args.callback) {
        args.callback();
      }
      return true;
    }
    return originalWrite(filtered, args.encoding, args.callback);
  };
}

type CharacterConfig = {
  settings: CharacterSettings;
  secrets: Record<string, string>;
};

function buildCharacter(config: CharacterConfig): Character {
  return createCharacter({
    name: "Eliza",
    username: "eliza",
    bio: [
      "An autonomous agent that explores Polymarket opportunities.",
      "Uses available tools to scan markets and place orders responsibly.",
    ],
    adjectives: ["focused", "pragmatic", "direct"],
    style: {
      all: [
        "Use available tools to inspect markets before acting",
        "Keep responses short and operational",
      ],
      chat: ["Be concise", "Log actions clearly"],
    },
    settings: config.settings,
    secrets: config.secrets,
  });
}

function buildCharacterSettings(
  options: CliOptions,
  config: EnvConfig
): CharacterConfig {
  const signatureTypeSecret =
    typeof config.signatureType === "number" ? String(config.signatureType) : undefined;

  const secrets: Record<string, string> = {
    EVM_PRIVATE_KEY: config.privateKey,
    POLYMARKET_PRIVATE_KEY: config.privateKey,
    CLOB_API_URL: config.clobApiUrl,
    ...(signatureTypeSecret
      ? {
          POLYMARKET_SIGNATURE_TYPE: signatureTypeSecret,
        }
      : {}),
    ...(config.funderAddress
      ? {
          POLYMARKET_FUNDER_ADDRESS: config.funderAddress,
        }
      : {}),
    ...(config.creds
      ? {
          CLOB_API_KEY: config.creds.key,
          CLOB_API_SECRET: config.creds.secret,
          CLOB_API_PASSPHRASE: config.creds.passphrase,
        }
      : {}),
    ...(options.rpcUrl
      ? {
          [`ETHEREUM_PROVIDER_${options.chain.toUpperCase()}`]: options.rpcUrl,
          [`EVM_PROVIDER_${options.chain.toUpperCase()}`]: options.rpcUrl,
        }
      : {}),
  };

  const settings: CharacterSettings = {
    chains: {
      evm: [options.chain],
    },
  };

  return { settings, secrets };
}

function collectEnvSnapshot(fileValues: Record<string, string>): EnvSnapshot {
  const snapshot: EnvSnapshot = { ...fileValues };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.trim().length > 0) {
      snapshot[key] = value.trim();
    }
  }
  return snapshot;
}

function getEnvValue(snapshot: EnvSnapshot, key: string): string | undefined {
  const value = snapshot[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveProvider(snapshot: EnvSnapshot): LlmProvider | null {
  return resolveLlmProvider((key) => getEnvValue(snapshot, key));
}

function resolveModel(snapshot: EnvSnapshot, provider: LlmProvider | null): string | null {
  return resolveLlmModel(provider, (key) => getEnvValue(snapshot, key));
}

function isMissingRequired(value: string | undefined): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

type SettingsFieldOptions = {
  readonly includeProvider: boolean;
};

function buildSettingsFields(
  snapshot: EnvSnapshot,
  options: CliOptions,
  fieldOptions: SettingsFieldOptions
): SettingsField[] {
  const provider = resolveProvider(snapshot) ?? "openai";
  const model = resolveModel(snapshot, provider) ?? DEFAULT_LLM_MODELS[provider];
  const fields: SettingsField[] = [];
  if (fieldOptions.includeProvider) {
    fields.push({
      key: "ELIZA_LLM_PROVIDER",
      label: "LLM Provider",
      type: "select",
      options: PROVIDER_OPTIONS,
      value: provider,
    });
  }
  fields.push(
    {
      key: "ELIZA_LLM_MODEL",
      label: "LLM Model",
      value: model,
      required: true,
    },
    {
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      value: getEnvValue(snapshot, "OPENAI_API_KEY") ?? "",
      secret: true,
      required: provider === "openai",
    },
    {
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API Key",
      value: getEnvValue(snapshot, "ANTHROPIC_API_KEY") ?? "",
      secret: true,
      required: provider === "anthropic",
    },
    {
      key: "GOOGLE_GENERATIVE_AI_API_KEY",
      label: "Gemini API Key",
      value: getEnvValue(snapshot, "GOOGLE_GENERATIVE_AI_API_KEY") ?? "",
      secret: true,
      required: provider === "gemini",
    },
    {
      key: "GROQ_API_KEY",
      label: "Groq API Key",
      value: getEnvValue(snapshot, "GROQ_API_KEY") ?? "",
      secret: true,
      required: provider === "groq",
    },
    {
      key: "XAI_API_KEY",
      label: "Grok API Key",
      value: getEnvValue(snapshot, "XAI_API_KEY") ?? "",
      secret: true,
      required: provider === "grok",
    },
    {
      key: "EVM_PRIVATE_KEY",
      label: "Polymarket Wallet Private Key",
      value:
        getEnvValue(snapshot, "EVM_PRIVATE_KEY") ??
        getEnvValue(snapshot, "POLYMARKET_PRIVATE_KEY") ??
        "",
      secret: true,
      required: true,
    },
    {
      key: "CLOB_API_URL",
      label: "CLOB API URL",
      value: getEnvValue(snapshot, "CLOB_API_URL") ?? "https://clob.polymarket.com",
    },
    {
      key: "CLOB_API_KEY",
      label: "CLOB API Key",
      value: getEnvValue(snapshot, "CLOB_API_KEY") ?? "",
      secret: true,
      required: options.execute,
    },
    {
      key: "CLOB_API_SECRET",
      label: "CLOB API Secret",
      value: getEnvValue(snapshot, "CLOB_API_SECRET") ?? "",
      secret: true,
      required: options.execute,
    },
    {
      key: "CLOB_API_PASSPHRASE",
      label: "CLOB API Passphrase",
      value: getEnvValue(snapshot, "CLOB_API_PASSPHRASE") ?? "",
      secret: true,
      required: options.execute,
    },
    {
      key: "POLYMARKET_SIGNATURE_TYPE",
      label: "Polymarket Signature Type",
      value: getEnvValue(snapshot, "POLYMARKET_SIGNATURE_TYPE") ?? "",
    },
    {
      key: "POLYMARKET_FUNDER_ADDRESS",
      label: "Polymarket Funder Address",
      value: getEnvValue(snapshot, "POLYMARKET_FUNDER_ADDRESS") ?? "",
    }
  );
  return fields;
}

function findMissingRequired(fields: SettingsField[]): string[] {
  return fields
    .filter((field) => field.required)
    .filter((field) => isMissingRequired(field.value))
    .map((field) => field.label);
}

async function ensureEnvConfig(options: CliOptions, force: boolean): Promise<void> {
  const envPath = resolveEnvPath();
  const envFile = await readEnvFile(envPath);
  const snapshot = collectEnvSnapshot(envFile.values);
  const resolvedProvider = resolveProvider(snapshot);
  const fields = buildSettingsFields(snapshot, options, {
    includeProvider: force || resolvedProvider === null,
  });
  const missingRequired = findMissingRequired(fields);
  if (!force && missingRequired.length === 0) {
    return;
  }

  const result = await runSettingsWizard({
    title: "Polymarket Setup",
    subtitle:
      missingRequired.length > 0
        ? `Missing required: ${missingRequired.join(", ")}`
        : "Enter required secrets to continue.",
    fields,
  });
  if (result.status !== "saved") {
    throw new Error("Setup cancelled.");
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.values)) {
    if (value.trim().length > 0) {
      updates[key] = value.trim();
    }
  }
  await writeEnvFile(envPath, envFile.lines, updates);
  applyEnvValues(updates);
}

function resolveRuntimeProvider(): LlmProvider | null {
  return resolveLlmProvider((key) => {
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
  });
}

function resolveRuntimeModel(provider: LlmProvider | null): string | null {
  return resolveLlmModel(provider, (key) => {
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
  });
}

function buildLlmPlugins(provider: LlmProvider | null): Array<typeof openaiPlugin> {
  if (!provider) return [openaiPlugin];
  switch (provider) {
    case "anthropic":
      return [anthropicPlugin];
    case "gemini":
      return [googleGenAIPlugin];
    case "groq":
      return [groqPlugin];
    case "grok":
      return [XAIPlugin];
    case "openai":
    default:
      return [openaiPlugin];
  }
}

function buildRuntimeSettings(provider: LlmProvider | null): Record<string, string | undefined> {
  const model = resolveRuntimeModel(provider);
  const smallModel =
    process.env.ELIZA_LLM_SMALL_MODEL ?? process.env.LLM_SMALL_MODEL ?? model ?? undefined;
  const settings: Record<string, string | undefined> = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GROQ_BASE_URL: process.env.GROQ_BASE_URL,
    XAI_BASE_URL: process.env.XAI_BASE_URL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    GOOGLE_API_BASE_URL: process.env.GOOGLE_API_BASE_URL,
    LARGE_MODEL: model ?? undefined,
    SMALL_MODEL: smallModel,
    POSTGRES_URL: process.env.POSTGRES_URL || undefined,
    PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR || "memory://",
  };
  if (model) {
    if (provider === "openai") settings.OPENAI_LARGE_MODEL = model;
    if (provider === "anthropic") settings.ANTHROPIC_LARGE_MODEL = model;
    if (provider === "gemini") settings.GOOGLE_LARGE_MODEL = model;
    if (provider === "groq") settings.GROQ_LARGE_MODEL = model;
    if (provider === "grok") settings.XAI_LARGE_MODEL = model;
  }
  if (smallModel) {
    if (provider === "openai") settings.OPENAI_SMALL_MODEL = smallModel;
    if (provider === "anthropic") settings.ANTHROPIC_SMALL_MODEL = smallModel;
    if (provider === "gemini") settings.GOOGLE_SMALL_MODEL = smallModel;
    if (provider === "groq") settings.GROQ_SMALL_MODEL = smallModel;
    if (provider === "grok") settings.XAI_SMALL_MODEL = smallModel;
  }
  return settings;
}

async function createRuntimeSession(
  options: CliOptions,
  config: EnvConfig
): Promise<RuntimeSession> {
  const configBundle = buildCharacterSettings(options, config);
  const character = buildCharacter(configBundle);
  const agentId = stringToUuid(character.name ?? "eliza");
  const llmProvider = resolveRuntimeProvider();
  const llmPlugins = buildLlmPlugins(llmProvider);

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, polymarketPlugin, ...llmPlugins],
    settings: buildRuntimeSettings(llmProvider),
    logLevel: "error",
    enableAutonomy: true,
    actionPlanning: true,
    checkShouldRespond: false,
  });

  // Enable autonomy for action execution (user can toggle with /autonomy command)
  // Don't disable by default - actions need autonomy service to execute
  
  await runtime.initialize();

  await runtime.ensureConnection({
    entityId: DEFAULT_USER_ID,
    roomId: DEFAULT_ROOM_ID,
    worldId: DEFAULT_WORLD_ID,
    userName: "Operator",
    source: "polymarket-demo",
    channelId: "polymarket",
    serverId: "polymarket-server",
    type: ChannelType.DM,
  } as Parameters<typeof runtime.ensureConnection>[0]);

  return {
    runtime,
    roomId: DEFAULT_ROOM_ID,
    worldId: DEFAULT_WORLD_ID,
    userId: DEFAULT_USER_ID,
    agentId,
    options,
    config,
  };
}

async function startChat(session: RuntimeSession): Promise<void> {
  const { runtime, roomId, worldId, userId } = session;
  runtime.setSetting("AUTONOMY_TARGET_ROOM_ID", String(roomId));
  runtime.setSetting("AUTONOMY_MODE", "task");

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "Operator",
    source: "polymarket-demo",
    channelId: "polymarket-chat",
    serverId: "polymarket-server",
    type: ChannelType.DM,
  } as Parameters<typeof runtime.ensureConnection>[0]);

  const messageService = runtime.messageService;
  if (!messageService) {
    throw new Error("Message service not initialized - ensure OpenAI plugin is loaded.");
  }
  await runPolymarketTui({
    runtime,
    roomId,
    worldId,
    userId,
    messageService,
  });
}

async function resolveApiCredentials(
  options: CliOptions,
  config: EnvConfig
): Promise<EnvConfig> {
  const signer = new Wallet(config.privateKey);
  const client = new ClobClient(config.clobApiUrl, POLYGON_CHAIN_ID, signer);
  let derived: DerivedApiCreds | null = null;
  try {
    derived = await client.deriveApiKey();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.creds) {
      console.warn(
        `⚠️ Failed to derive API key (${message}); using .env credentials for this run.`
      );
      return config;
    }
    throw new Error(
      `Unable to derive API key (${message}). ` +
        "Create API credentials once in Polymarket and set CLOB_API_KEY, CLOB_API_SECRET, " +
        "CLOB_API_PASSPHRASE, or enable creation explicitly."
    );
  }

  const derivedKey = derived.key ?? derived.apiKey;
  if (!derivedKey) {
    throw new Error("Failed to derive API key: missing key in response.");
  }

  if (config.creds && config.creds.key !== derivedKey) {
    console.warn(
      "⚠️ CLOB_API_KEY does not match derived key; using derived credentials for this run."
    );
  }

  return {
    ...config,
    creds: {
      key: derivedKey,
      secret: derived.secret,
      passphrase: derived.passphrase,
    },
  };
}

function logSessionStart(options: CliOptions): void {
  console.log("✅ runtime initialized");
  console.log(`🔧 chain: ${options.chain}`);
  console.log(`🔧 execute: ${options.execute ? "enabled" : "disabled"}`);
}

async function runWithSession(
  options: CliOptions,
  handler: (session: RuntimeSession) => Promise<void>
): Promise<void> {
  wrapWriteStream(process.stdout);
  wrapWriteStream(process.stderr);
  await ensureEnvConfig(options, false);
  const rawConfig = loadEnvConfig(options);
  const config = await resolveApiCredentials(options, rawConfig);
  const session = await createRuntimeSession(options, config);
  let exiting = false;
  const onSigint = () => {
    if (exiting) return;
    exiting = true;
    void session.runtime.stop().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", onSigint);

  logSessionStart(options);
  try {
    await handler(session);
  } finally {
    process.off("SIGINT", onSigint);
    await session.runtime.stop();
  }
}

export async function verify(options: CliOptions): Promise<void> {
  await runWithSession(options, async (session) => {
    console.log("✅ clob api url:", session.config.clobApiUrl);
    console.log("✅ creds present:", String(session.config.creds !== null));
  });
}

export async function chat(options: CliOptions): Promise<void> {
  await runWithSession(options, async (session) => {
    await startChat(session);
  });
}

export async function settings(options: CliOptions): Promise<void> {
  await ensureEnvConfig(options, true);
  console.log("✅ settings saved to .env");
}

export async function inputTest(options: CliOptions): Promise<void> {
  void options;
  runInkInputTest();
}