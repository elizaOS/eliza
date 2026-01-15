import {
  AgentRuntime,
  ChannelType,
  type Character,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { AutonomyService } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import polymarketPlugin from "@elizaos/plugin-polymarket";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { loadEnvConfig, type CliOptions, type EnvConfig } from "./lib";
import { runPolymarketTui } from "./tui";

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

function createCharacter(settings: CharacterSettings): Character {
  return {
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
    settings,
  };
}

function buildCharacterSettings(
  options: CliOptions,
  config: EnvConfig
): CharacterSettings {
  const signatureTypeSecret =
    typeof config.signatureType === "number" ? String(config.signatureType) : undefined;

  return {
    chains: {
      evm: [options.chain],
    },
    secrets: {
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
    },
  };
}

async function createRuntimeSession(
  options: CliOptions,
  config: EnvConfig
): Promise<RuntimeSession> {
  const settings = buildCharacterSettings(options, config);
  const character = createCharacter(settings);
  const agentId = stringToUuid(character.name);

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, polymarketPlugin, openaiPlugin],
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      POSTGRES_URL: process.env.POSTGRES_URL || undefined,
      PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR || "memory://",
    },
    logLevel: "info", // Changed from "error" to debug action selection
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
  if (!options.network) {
    return config;
  }

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
  console.log(`🔧 network: ${options.network ? "enabled" : "disabled"}`);
}

async function runWithSession(
  options: CliOptions,
  handler: (session: RuntimeSession) => Promise<void>
): Promise<void> {
  const rawConfig = loadEnvConfig(options);
  const config = await resolveApiCredentials(options, rawConfig);
  const session = await createRuntimeSession(options, config);

  logSessionStart(options);
  try {
    await handler(session);
  } finally {
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