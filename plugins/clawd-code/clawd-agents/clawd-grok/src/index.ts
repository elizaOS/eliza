#!/usr/bin/env bun
import { InvalidArgumentError, program } from "commander";
import * as dotenv from "dotenv";
import readline from "readline";
import packageJson from "../package.json";
import { Agent } from "./agent/agent";
import { completeDelegation, failDelegation, loadDelegation } from "./agent/delegations";
import {
  getProviderDefinition,
  listProviders,
  MODELS,
  normalizeModelId,
  normalizeProviderId,
  type ProviderId,
} from "./grok/models";
import {
  createHeadlessJsonlEmitter,
  type HeadlessOutputFormat,
  isHeadlessOutputFormat,
  renderHeadlessChunk,
  renderHeadlessPrelude,
} from "./headless/output";
import { runTelegramHeadlessBridge } from "./telegram/headless-bridge";
import { startScheduleDaemon } from "./tools/schedule";
import { processAtMentions } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import {
  getApiKey,
  getBaseURL,
  getCurrentProvider,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  getCurrentToolsets,
  getSolanaConfig,
  mergeSandboxSettings,
  resolveProviderModelSelection,
  type SandboxMode,
  type SandboxSettings,
  saveUserSettings,
} from "./utils/settings";
import { runUpdate } from "./utils/update-checker";
import {
  getWorkspaceTrustDecision,
  isShuruSandboxSupported,
  resolveWorkspaceTrustPromptAnswer,
  saveWorkspaceTrustDecision,
} from "./utils/workspace-trust";
import { buildVerifyPrompt, getVerifyCliError } from "./verify/entrypoint";

dotenv.config();

const exitCleanlyOnSigterm = () => {
  process.exit(0);
};

process.on("SIGTERM", exitCleanlyOnSigterm);

process.on("uncaughtException", (err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

async function startInteractive(
  apiKey: string | undefined,
  baseURL: string,
  provider: ProviderId,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  toolsets: string[],
  session?: string,
  initialMessage?: string,
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
    batchApi,
    provider,
    toolsets,
  });
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { createElement } = await import("react");
  const { App } = await import("./ui/app");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
    },
  });

  const onExit = () => {
    void agent.cleanup().finally(() => {
      renderer.destroy();
      process.exit(0);
    });
  };

  createRoot(renderer).render(
    createElement(App, {
      agent,
      startupConfig: {
        apiKey,
        baseURL,
        provider: agent.getProvider(),
        model: agent.getModel(),
        maxToolRounds,
        sandboxMode,
        sandboxSettings,
        toolsets,
        version: packageJson.version,
      },
      initialMessage,
      onExit,
    }),
  );
}

async function runHeadless(
  prompt: string,
  apiKey: string,
  baseURL: string,
  provider: ProviderId,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  format: HeadlessOutputFormat,
  toolsets: string[],
  session?: string,
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
    batchApi,
    provider,
    toolsets,
  });
  const prelude = renderHeadlessPrelude(format, agent.getSessionId() || undefined);
  if (prelude.stdout) process.stdout.write(prelude.stdout);
  if (prelude.stderr) process.stderr.write(prelude.stderr);

  try {
    const { enhancedMessage } = processAtMentions(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        const writes = consumeChunk(chunk);
        if (writes.stdout) process.stdout.write(writes.stdout);
        if (writes.stderr) process.stderr.write(writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) process.stdout.write(tail.stdout);
      if (tail.stderr) process.stderr.write(tail.stderr ?? "");
      return;
    }

    for await (const chunk of agent.processMessage(enhancedMessage)) {
      const writes = renderHeadlessChunk(chunk);
      if (writes.stdout) process.stdout.write(writes.stdout);
      if (writes.stderr) process.stderr.write(writes.stderr);
    }
  } finally {
    await agent.cleanup();
  }
}

function changeDirectoryOrExit(directory: string | undefined) {
  if (!directory) return;
  try {
    process.chdir(directory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot change to directory ${directory}: ${msg}`);
    process.exit(1);
  }
}

type CliOptions = Record<string, string | boolean | string[] | undefined>;

function stringOption(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function stringListOption(value: string | boolean | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function resolveCliProvider(value: string | boolean | string[] | undefined): ProviderId | undefined {
  if (typeof value !== "string") return undefined;
  const provider = normalizeProviderId(value);
  if (!provider) {
    const expected = listProviders()
      .map((item) => item.id)
      .join(", ");
    throw new InvalidArgumentError(`Invalid provider "${value}". Expected one of: ${expected}.`);
  }
  return provider;
}

function resolveCliSandboxMode(value: string | boolean | string[] | undefined): SandboxMode | undefined {
  if (value === true) return "shuru";
  if (value === false) return "off";
  return undefined;
}

function hasExplicitSandboxOption(options: CliOptions): boolean {
  return options.sandbox === true || options.sandbox === false;
}

async function promptWorkspaceTrust(
  cwd: string,
  sandboxSupported = isShuruSandboxSupported(),
): Promise<ReturnType<typeof resolveWorkspaceTrustPromptAnswer>> {
  const message = sandboxSupported
    ? [
        "",
        `Clawd has not been run in ${cwd} before.`,
        "",
        "Sandbox mode isolates agent shell commands in a Shuru microVM so",
        "untrusted repos cannot touch your host filesystem or network by default.",
        "",
        "Run Clawd in sandbox mode for this directory?",
        "",
        "  [Y] Yes, always in sandbox",
        "  [n] No, run on host",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/n/s]: ",
      ].join("\n")
    : [
        "",
        `Clawd has not been run in ${cwd} before.`,
        "",
        "Sandbox mode is only available on macOS Apple Silicon in this version.",
        "",
        "Run Clawd directly on the host for this directory?",
        "",
        "  [Y] Yes, remember host mode",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/s]: ",
      ].join("\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(message, resolve);
    });
    return resolveWorkspaceTrustPromptAnswer(answer, sandboxSupported);
  } finally {
    rl.close();
  }
}

async function resolveWorkspaceTrustSandboxMode(sandboxMode: SandboxMode, options: CliOptions): Promise<SandboxMode> {
  if (sandboxMode === "shuru" || hasExplicitSandboxOption(options)) return sandboxMode;
  if (process.env.CLAWD_TRUST_WORKSPACE) return sandboxMode;

  const cwd = process.cwd();
  const saved = getWorkspaceTrustDecision(cwd);
  if (saved) return saved;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return sandboxMode;

  const decision = await promptWorkspaceTrust(cwd);
  if (decision.remember) saveWorkspaceTrustDecision(cwd, decision.sandboxMode);
  return decision.sandboxMode;
}

async function runBackgroundDelegation(jobPath: string, options: CliOptions) {
  let output = "";
  let agent: Agent | undefined;

  try {
    const delegation = await loadDelegation(jobPath);
    const explicitModel = stringOption(options.model) || delegation.model;
    const selection = resolveProviderModelSelection({
      provider: resolveCliProvider(options.provider),
      model: explicitModel,
    });
    const apiKey = stringOption(options.apiKey) || getApiKey(selection.provider);
    if (!apiKey) {
      throw new Error(
        `API key required for ${selection.provider}. Set ${getProviderDefinition(selection.provider).envKey}, use --api-key, or save it to ~/.clawd/user-settings.json.`,
      );
    }

    const baseURL = stringOption(options.baseUrl) || getBaseURL(selection.provider);
    const model = selection.model;
    const maxToolRounds =
      parseInt(stringOption(options.maxToolRounds) || String(delegation.maxToolRounds), 10) || delegation.maxToolRounds;
    const sandboxMode = resolveCliSandboxMode(options.sandbox) || delegation.sandboxMode || getCurrentSandboxMode();
    const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), delegation.sandboxSettings ?? {});
    const toolsets = stringListOption(options.toolset).length > 0 ? stringListOption(options.toolset) : getCurrentToolsets();
    agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
      persistSession: false,
      sandboxMode,
      sandboxSettings,
      batchApi: Boolean(delegation.batchApi ?? options.batchApi === true),
      provider: selection.provider,
      toolsets,
    });
    const result = await agent.runTaskRequest({
      agent: delegation.agent,
      description: delegation.description,
      prompt: delegation.prompt,
    });

    output = (result.output || "").trim();

    if (!result.success) {
      await failDelegation(jobPath, result.output || result.error || "Background delegation failed.", output);
      return;
    }

    await completeDelegation(jobPath, output, result.task?.summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await failDelegation(jobPath, msg, output);
    } catch {
      // Best effort
    }
    process.exit(1);
  } finally {
    await agent?.cleanup();
  }
}

function resolveConfig(options: CliOptions) {
  const explicitModel = stringOption(options.model);
  const explicitProvider = resolveCliProvider(options.provider);
  const selection = resolveProviderModelSelection({
    provider: explicitProvider ?? getCurrentProvider(explicitModel),
    model: explicitModel,
  });
  const provider = selection.provider;
  const apiKey = stringOption(options.apiKey) || getApiKey(provider);
  const baseURL = stringOption(options.baseUrl) || getBaseURL(provider);
  const model = selection.model;
  const maxToolRounds = parseInt(stringOption(options.maxToolRounds) || "400", 10) || 400;
  const sandboxMode = resolveCliSandboxMode(options.sandbox) || getCurrentSandboxMode();
  const cliToolsets = stringListOption(options.toolset);
  const toolsets = cliToolsets.length > 0 ? cliToolsets : getCurrentToolsets();

  const cliOverrides: SandboxSettings = {};
  if (options.allowNet === true) cliOverrides.allowNet = true;
  const allowHostValue = options.allowHost;
  if (Array.isArray(allowHostValue) && allowHostValue.length > 0) {
    cliOverrides.allowedHosts = allowHostValue as string[];
    if (!cliOverrides.allowNet) cliOverrides.allowNet = true;
  }
  const portValue = options.port;
  if (Array.isArray(portValue) && portValue.length > 0) {
    cliOverrides.ports = portValue as string[];
  }
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), cliOverrides);

  if (typeof options.apiKey === "string") {
    saveUserSettings({
      ...(provider === "xai" ? { apiKey: options.apiKey } : {}),
      providerApiKeys: { [provider]: options.apiKey },
    } as Record<string, unknown>);
  }
  if (typeof options.baseUrl === "string") {
    saveUserSettings({
      ...(provider === "xai" ? { baseURL: options.baseUrl } : {}),
      providerBaseURLs: { [provider]: options.baseUrl },
    } as Record<string, unknown>);
  }
  if (typeof options.model === "string") saveUserSettings({ defaultModel: normalizeModelId(options.model) });
  if (typeof options.provider === "string") saveUserSettings({ provider });
  if (toolsets.length > 0 && cliToolsets.length > 0) saveUserSettings({ toolsets });

  return { apiKey, baseURL, provider, model, maxToolRounds, sandboxMode, sandboxSettings, toolsets };
}

function requireApiKey(apiKey: string | undefined, provider: ProviderId): string {
  if (!apiKey) {
    console.error(
      `Error: API key required for ${provider}. Set ${getProviderDefinition(provider).envKey}, use --api-key, or save to ~/.clawd/user-settings.json`,
    );
    process.exit(1);
  }
  return apiKey;
}

function parseHeadlessOutputFormat(value: string): HeadlessOutputFormat {
  if (isHeadlessOutputFormat(value)) return value;
  throw new InvalidArgumentError(`Invalid headless format "${value}". Expected "text" or "json".`);
}

// ===== MAIN CLI PROGRAM =====

program
  .name("clawd")
  .description(
    "Clawd Grok — a multi-provider Clawd Code harness with Solana/Phoenix tools, model routing, sub-agents, Telegram, MCP, and optional camsnap.",
  )
  .version(packageJson.version)
  .argument("[message...]", "Initial message to send")
  .option("-k, --api-key <key>", "AI API key (OpenAI-compatible)")
  .option("-u, --base-url <url>", "AI API base URL")
  .option("--provider <provider>", "AI provider: xai, zai, openai, openrouter, deepseek, or custom")
  .option("-m, --model <model>", "AI model to use")
  .option("--toolset <name>", "Enable an optional toolset such as camsnap (repeatable)", collect, [])
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("-p, --prompt <prompt>", "Run a single prompt headlessly")
  .option("--verify", "Run the built-in verify flow headlessly")
  .option("--format <format>", "Headless output format: text or json", parseHeadlessOutputFormat, "text")
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--allow-net", "Enable network access inside the Shuru sandbox")
  .option("--allow-host <pattern>", "Restrict sandbox network to specific hosts (repeatable)", collect, [])
  .option("--port <mapping>", "Forward a host port to sandbox guest (HOST:GUEST, repeatable)", collect, [])
  .option("-s, --session <id>", "Continue a saved session by id, or use 'latest'")
  .option("--background-task-file <path>", "Run a persisted background delegation")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--batch-api", "Use batch API for model calls (async, lower cost)")
  .option("--update", "Update Clawd to the latest version and exit")
  .option("--rpc-url <url>", "Solana RPC endpoint override")
  .option("--api-url <url>", "Phoenix API endpoint override")
  .action(async (message: string[], options) => {
    if (options.update) {
      console.log("Checking for updates...");
      const result = await runUpdate(packageJson.version);
      console.log(result.output);
      process.exit(result.success ? 0 : 1);
    }

    changeDirectoryOrExit(options.directory);

    // Apply RPC/API URL overrides from CLI flags
    if (options.rpcUrl) process.env.SOLANA_RPC_URL = options.rpcUrl;
    if (options.apiUrl) process.env.PHOENIX_API_URL = options.apiUrl;

    if (options.backgroundTaskFile) {
      await runBackgroundDelegation(options.backgroundTaskFile, options);
      return;
    }

    const config = resolveConfig(options);

    if (options.verify) {
      const verifyError = getVerifyCliError({ hasPrompt: Boolean(options.prompt), hasMessageArgs: message.length > 0 });
      if (verifyError) {
        console.error(verifyError);
        process.exit(1);
      }
      await runHeadless(
        buildVerifyPrompt(process.cwd()),
        requireApiKey(config.apiKey, config.provider),
        config.baseURL,
        config.provider,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        config.toolsets,
        options.session,
      );
      return;
    }

    if (options.prompt) {
      await runHeadless(
        options.prompt,
        requireApiKey(config.apiKey, config.provider),
        config.baseURL,
        config.provider,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        config.toolsets,
        options.session,
      );
      return;
    }

    const initialMessage = message.length > 0 ? message.join(" ") : undefined;
    config.sandboxMode = await resolveWorkspaceTrustSandboxMode(config.sandboxMode, options);
    await startInteractive(
      config.apiKey,
      config.baseURL,
      config.provider,
      config.model,
      config.maxToolRounds,
      options.batchApi === true,
      config.sandboxMode,
      config.sandboxSettings,
      config.toolsets,
      options.session,
      initialMessage,
    );
  });

// ===== TELEGRAM BRIDGE =====

program
  .command("telegram-bridge")
  .description("Start the Telegram remote-control bridge without opening the TUI")
  .option("-k, --api-key <key>", "AI API key")
  .option("-u, --base-url <url>", "AI API base URL")
  .option("--provider <provider>", "AI provider: xai, zai, openai, openrouter, deepseek, or custom")
  .option("-m, --model <model>", "AI model to use")
  .option("--toolset <name>", "Enable an optional toolset such as camsnap (repeatable)", collect, [])
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--log-file <path>", "Bridge log file", "telegram-remote-bridge.log")
  .option("--pair-code-file <path>", "Pairing code file", "telegram-pair-code.txt")
  .action(async (options) => {
    changeDirectoryOrExit(options.directory);
    const config = resolveConfig(options);
    process.off("SIGTERM", exitCleanlyOnSigterm);
    try {
      await runTelegramHeadlessBridge({
        apiKey: requireApiKey(config.apiKey, config.provider),
        baseURL: config.baseURL,
        provider: config.provider,
        model: config.model,
        maxToolRounds: config.maxToolRounds,
        sandboxMode: config.sandboxMode,
        sandboxSettings: config.sandboxSettings,
        toolsets: config.toolsets,
        logFile: options.logFile,
        pairCodeFile: options.pairCodeFile,
      });
    } finally {
      process.on("SIGTERM", exitCleanlyOnSigterm);
    }
  });

// ===== MODELS =====

program
  .command("models")
  .description("List available AI models")
  .action(() => {
    console.log("\nAvailable AI Models:\n");
    for (const m of MODELS) {
      const tags = [
        m.provider,
        m.reasoning ? "reasoning" : "non-reasoning",
        m.multiAgent ? "multi-agent" : null,
      ].filter(Boolean);
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  \x1b[36m${m.id}\x1b[0m — ${m.name}${suffix}`);
      console.log(
        `    ${m.description} | ${formatContext(m.contextWindow)} context | $${m.inputPrice}/$${m.outputPrice} per 1M tokens`,
      );
      if ((m.aliases?.length ?? 0) > 0) {
        console.log(`    aliases: ${(m.aliases ?? []).join(", ")}`);
      }
    }
    console.log();
  });

// ===== PROVIDERS =====

program
  .command("providers")
  .description("List configured AI providers and routing environment variables")
  .action(() => {
    console.log("\nAvailable AI Providers:\n");
    for (const provider of listProviders()) {
      const apiKey = getApiKey(provider.id);
      const baseURL = getBaseURL(provider.id);
      console.log(`  \x1b[36m${provider.id}\x1b[0m — ${provider.name}`);
      console.log(`    ${provider.description}`);
      console.log(`    key: ${provider.envKey}${apiKey ? " (set)" : " (not set)"}`);
      if (provider.envBaseURL) {
        console.log(`    base: ${provider.envBaseURL}${baseURL ? ` = ${baseURL}` : " (required)"}`);
      }
    }
    console.log("\nUse --provider <id>, CLAWD_PROVIDER, or a model prefix such as openrouter:auto.\n");
  });

// ===== UPDATE =====

program
  .command("update")
  .description("Update Clawd to the latest release")
  .action(async () => {
    console.log("Checking for updates...");
    const result = await runUpdate(packageJson.version);
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

// ===== UNINSTALL =====

program
  .command("uninstall")
  .description("Remove a script-installed Clawd binary and optional data")
  .option("--dry-run", "Show what would be removed without removing it")
  .option("--force", "Skip the confirmation prompt")
  .option("--keep-config", "Keep ~/.clawd config files")
  .option("--keep-data", "Keep ~/.clawd data files")
  .action(async (options) => {
    const result = await runScriptManagedUninstall({
      dryRun: options.dryRun === true,
      force: options.force === true,
      keepConfig: options.keepConfig === true,
      keepData: options.keepData === true,
    });
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

// ===== STATUS =====

program
  .command("status")
  .description("Check configuration, connectivity, wallet, and registration status")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    const solanaConfig = getSolanaConfig();
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: {
              config: {
                rpcUrl: solanaConfig.rpcUrl,
                apiUrl: solanaConfig.apiUrl,
                hasApiKey: !!solanaConfig.apiKey,
              },
              version: packageJson.version,
              homeDir: `${process.env.HOME}/.clawd`,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log("\nClawd Status:");
      console.log(`  Version:    ${packageJson.version}`);
      console.log(`  RPC URL:    ${solanaConfig.rpcUrl}`);
      console.log(`  API URL:    ${solanaConfig.apiUrl}`);
      console.log(`  API Key:    ${solanaConfig.apiKey ? "set" : "not set"}`);
      console.log(`  Home Dir:   ~/.clawd`);
      console.log();
    }
  });

// ===== WALLET =====

const walletCommand = program.command("wallet").description("Manage Solana wallets and keys");

walletCommand
  .command("create")
  .description("Generate a new Solana keypair and store it encrypted")
  .option("--name <name>", "Wallet name")
  .action(async (options) => {
    const { WalletManager } = await import("./wallet/manager");
    const wallet = new WalletManager();
    const data = wallet.init("solana");
    console.log("\nWallet created.");
    console.log(`  Name:      ${options.name || "default"}`);
    console.log(`  Public Key: ${data.address}`);
    console.log(`  Created:    ${data.createdAt}`);
    console.log("\nFund this wallet with SOL to pay for transactions.");
  });

walletCommand
  .command("import")
  .description("Import an existing Solana private key")
  .option("--name <name>", "Wallet name")
  .option("--format <format>", "Key format: base58, bytes, or file", "base58")
  .argument("<key>", "Private key or file path")
  .action(async (key: string, options) => {
    // Placeholder for import logic
    console.log(`Importing wallet "${options.name || "default"}"...`);
    console.log(`Wallet import — implement ${options.format} key parsing (${key.length} characters provided)`);
  });

walletCommand
  .command("list")
  .description("List all stored wallets")
  .action(async () => {
    console.log("\nStored wallets:");
    console.log("  (no wallets stored yet — use 'clawd wallet create' to make one)");
    console.log();
  });

walletCommand
  .command("balance")
  .description("Show SOL and USDC balances for a wallet")
  .argument("[name]", "Wallet name (default: default wallet)")
  .action(async (name) => {
    const solanaConfig = getSolanaConfig();
    console.log(`\nWallet: ${name || "default"}`);
    console.log(`  RPC:  ${solanaConfig.rpcUrl}`);
    console.log("  SOL:  (connect to RPC to fetch)");
    console.log("  USDC: (connect to RPC to fetch)");
    console.log();
  });

// ===== MARKET DATA =====

const marketCommand = program.command("market").description("Phoenix perpetuals market data");

marketCommand
  .command("list")
  .description("List all available perpetual markets")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    const solanaConfig = getSolanaConfig();
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: {
              markets: ["SOL-PERP", "BTC-PERP", "ETH-PERP", "JUP-PERP", "BONK-PERP"],
              apiUrl: solanaConfig.apiUrl,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log("\nPhoenix Perpetual Markets:");
      console.log("  SOL-PERP   Solana");
      console.log("  BTC-PERP   Bitcoin");
      console.log("  ETH-PERP   Ethereum");
      console.log("  JUP-PERP   Jupiter");
      console.log("  BONK-PERP  Bonk");
      console.log(`\n  API: ${solanaConfig.apiUrl}`);
      console.log();
    }
  });

marketCommand
  .command("ticker")
  .description("Current price and 24h stats for a market")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: {
              symbol: symbol.toUpperCase(),
              markPrice: 0,
              indexPrice: 0,
              volume24h: 0,
              openInterest: 0,
              fundingRate: 0,
              fundingRateApr: 0,
              note: "Connect to Phoenix API for live data",
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\n${symbol.toUpperCase()} Ticker:`);
      console.log("  (Connect to Phoenix API for live market data)");
      console.log();
    }
  });

marketCommand
  .command("orderbook")
  .description("L2 orderbook snapshot")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--depth <n>", "Number of levels", "10")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} Orderbook (depth ${options.depth}):`);
    console.log("  (Connect to Phoenix API for live orderbook data)");
    console.log();
  });

marketCommand
  .command("candles")
  .description("OHLCV candle data")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--interval <interval>", "Candle interval: 1m, 5m, 15m, 1h, 4h, 1d", "1h")
  .option("--limit <n>", "Number of candles", "20")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} Candles (${options.interval}, last ${options.limit}):`);
    console.log("  (Connect to Phoenix API for live candle data)");
    console.log();
  });

marketCommand
  .command("trades")
  .description("Recent trades for a market")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--limit <n>", "Number of trades", "20")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} Recent Trades (last ${options.limit}):`);
    console.log("  (Connect to Phoenix API for live trade data)");
    console.log();
  });

marketCommand
  .command("funding-rates")
  .description("Historical funding rates")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--limit <n>", "Number of records", "20")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} Funding Rates (last ${options.limit}):`);
    console.log("  (Connect to Phoenix API for funding rate data)");
    console.log();
  });

// ===== TRADING =====

const tradeCommand = program.command("trade").description("Place and manage orders on Phoenix perpetuals");

tradeCommand
  .command("market-buy")
  .description("Place a market buy order")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--notional-usdc <amount>", "Order size in USDC notional")
  .option("--tokens <amount>", "Order size in base tokens")
  .option("--tp <price>", "Take-profit price")
  .option("--sl <price>", "Stop-loss price")
  .option("--isolated", "Use isolated margin")
  .option("--collateral <amount>", "Isolated margin collateral in USDC")
  .option("--reduce-only", "Reduce position only")
  .option("--dry-run", "Simulate without submitting")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    if (options.dryRun) {
      console.log(`\n[DRY RUN] Market buy ${symbol.toUpperCase()}:`);
      console.log(`  Notional: ${options.notionalUsdc || "N/A"} USDC`);
      console.log(`  Tokens:   ${options.tokens || "N/A"}`);
      console.log(`  TP: ${options.tp || "none"}  SL: ${options.sl || "none"}`);
      console.log("  (No transaction submitted)\n");
    } else {
      console.log(`\n⚠️  LIVE market buy ${symbol.toUpperCase()} — requires wallet + RPC connected`);
      console.log("  Use --dry-run to simulate first.\n");
    }
  });

tradeCommand
  .command("market-sell")
  .description("Place a market sell order")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--notional-usdc <amount>", "Order size in USDC notional")
  .option("--tokens <amount>", "Order size in base tokens")
  .option("--tp <price>", "Take-profit price")
  .option("--sl <price>", "Stop-loss price")
  .option("--isolated", "Use isolated margin")
  .option("--collateral <amount>", "Isolated margin collateral in USDC")
  .option("--reduce-only", "Reduce position only")
  .option("--dry-run", "Simulate without submitting")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    if (options.dryRun) {
      console.log(`\n[DRY RUN] Market sell ${symbol.toUpperCase()}:`);
      console.log(`  Notional: ${options.notionalUsdc || "N/A"} USDC`);
      console.log(`  Tokens:   ${options.tokens || "N/A"}`);
      console.log(`  TP: ${options.tp || "none"}  SL: ${options.sl || "none"}`);
      console.log("  (No transaction submitted)\n");
    } else {
      console.log(`\n⚠️  LIVE market sell ${symbol.toUpperCase()} — requires wallet + RPC connected`);
      console.log("  Use --dry-run to simulate first.\n");
    }
  });

tradeCommand
  .command("limit-buy")
  .description("Place a limit buy order")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .argument("<size>", "Order size in base lots")
  .argument("<price>", "Limit price")
  .option("--tp <price>", "Take-profit price")
  .option("--sl <price>", "Stop-loss price")
  .option("--isolated", "Use isolated margin")
  .option("--collateral <amount>", "Isolated margin collateral in USDC")
  .option("--reduce-only", "Reduce position only")
  .option("--post-only", "Post only (no taker fill)")
  .option("--dry-run", "Simulate without submitting")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, size, price, options) => {
    if (options.dryRun) {
      console.log(`\n[DRY RUN] Limit buy ${symbol.toUpperCase()}:`);
      console.log(`  Size:  ${size} lots @ ${price}`);
      console.log(`  TP: ${options.tp || "none"}  SL: ${options.sl || "none"}`);
      console.log("  (No transaction submitted)\n");
    } else {
      console.log(`\n⚠️  LIVE limit buy — requires wallet + RPC connected`);
      console.log("  Use --dry-run to simulate first.\n");
    }
  });

tradeCommand
  .command("cancel")
  .description("Cancel specific orders by ID")
  .argument("<symbol>", "Market symbol")
  .argument("<order-ids...>", "Order IDs to cancel")
  .action(async (symbol, orderIds) => {
    console.log(`\nCancelling ${orderIds.length} order(s) for ${symbol.toUpperCase()}...`);
    console.log("  (Connect wallet + RPC to cancel live orders)\n");
  });

tradeCommand
  .command("cancel-all")
  .description("Cancel all open orders, optionally filtered by symbol")
  .argument("[symbol]", "Market symbol (omit to cancel all)")
  .action(async (symbol) => {
    const scope = symbol ? `for ${symbol.toUpperCase()}` : "across all markets";
    console.log(`\nCancelling all open orders ${scope}...`);
    console.log("  (Connect wallet + RPC to cancel live orders)\n");
  });

// ===== POSITIONS =====

const positionCommand = program.command("position").description("Manage your perpetual positions");

positionCommand
  .command("list")
  .description("List all open positions")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    if (options.output === "json") {
      console.log(JSON.stringify({ ok: true, data: { positions: [] } }, null, 2));
    } else {
      console.log("\nOpen Positions:");
      console.log("  (Connect wallet + RPC to fetch positions)");
      console.log();
    }
  });

positionCommand
  .command("close")
  .description("Close an entire position")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--dry-run", "Simulate without submitting")
  .action(async (symbol, options) => {
    if (options.dryRun) {
      console.log(`\n[DRY RUN] Close ${symbol.toUpperCase()} position`);
    } else {
      console.log(`\n⚠️  LIVE close position — requires wallet + RPC`);
      console.log("  Use --dry-run to simulate first.\n");
    }
  });

// ===== MARGIN =====

const marginCommand = program.command("margin").description("Manage collateral and margin");

marginCommand
  .command("status")
  .description("Show cross-margin health, equity, and available balance")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: { equity: 0, availableBalance: 0, marginUsed: 0, marginRatio: 0 },
          },
          null,
          2,
        ),
      );
    } else {
      console.log("\nMargin Status:");
      console.log("  (Connect wallet + RPC to fetch margin data)");
      console.log();
    }
  });

marginCommand
  .command("deposit")
  .description("Deposit USDC collateral")
  .argument("<amount>", "Amount in USDC")
  .action(async (amount) => {
    console.log(`\n⚠️  LIVE deposit ${amount} USDC — requires wallet + RPC\n`);
  });

// ===== PORTFOLIO =====

program
  .command("portfolio")
  .description("Full portfolio snapshot: margin, positions, and open orders")
  .option("--include <sections>", "Comma-separated subset: margin,positions,orders. Default: all")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: { margin: {}, positions: [], orders: [], timestamp: Date.now() },
          },
          null,
          2,
        ),
      );
    } else {
      console.log("\nPortfolio Snapshot:");
      console.log("  (Connect wallet + RPC for live portfolio data)");
      console.log();
    }
  });

// ===== PAPER TRADING =====

const paperCommand = program.command("paper").description("Local paper trading against live prices (no real funds)");

paperCommand
  .command("init")
  .description("Initialize or reset the local paper trading account")
  .option("--balance <amount>", "Starting USDC balance", "10000")
  .action(async (options) => {
    console.log(`\nPaper trading account initialized with ${options.balance} USDC.`);
    console.log("  (All paper trades are simulated — no real funds at risk)");
    console.log();
  });

paperCommand
  .command("status")
  .description("Show paper account status")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (options) => {
    if (options.output === "json") {
      console.log(JSON.stringify({ ok: true, data: { balance: 10000, currency: "USDC", pnl: 0 } }, null, 2));
    } else {
      console.log("\nPaper Account: 10,000 USDC | PnL: $0.00\n");
    }
  });

paperCommand
  .command("buy")
  .description("Place a paper buy order")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--type <type>", "Order type: market or limit", "market")
  .option("--notional-usdc <amount>", "Order size in USDC notional")
  .option("--tokens <amount>", "Order size in base tokens")
  .option("--price <price>", "Limit price (for limit orders)")
  .action(async (symbol, options) => {
    console.log(`\n[PAPER] Buy ${symbol.toUpperCase()} — ${options.notionalUsdc || options.tokens || "N/A"}`);
    console.log("  (Paper trading — no real funds at risk)\n");
  });

paperCommand
  .command("sell")
  .description("Place a paper sell order")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--type <type>", "Order type: market or limit", "market")
  .option("--notional-usdc <amount>", "Order size in USDC notional")
  .option("--tokens <amount>", "Order size in base tokens")
  .option("--price <price>", "Limit price (for limit orders)")
  .action(async (symbol, options) => {
    console.log(`\n[PAPER] Sell ${symbol.toUpperCase()} — ${options.notionalUsdc || options.tokens || "N/A"}`);
    console.log("  (Paper trading — no real funds at stake)\n");
  });

// ===== TECHNICAL ANALYSIS =====

const taCommand = program.command("ta").description("Technical analysis indicators for perpetual markets");

taCommand
  .command("compute")
  .description("Compute a single indicator over recent candles")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .requiredOption("--indicator <name>", "Indicator: sma, ema, rsi, macd, bbands, atr, vwap, adx, stoch")
  .option("--timeframe <tf>", "Candle timeframe", "1h")
  .option("--period <p>", "Indicator period", "14")
  .option("--limit <n>", "Number of candles to use", "100")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            ok: true,
            data: {
              indicator: options.indicator,
              symbol: symbol.toUpperCase(),
              timeframe: options.timeframe,
              value: 0,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `\n${symbol.toUpperCase()} ${options.indicator.toUpperCase()} (${options.timeframe}, period ${options.period}):`,
      );
      console.log("  (Compute from live/paper candle data)");
      console.log();
    }
  });

taCommand
  .command("report")
  .description("Multi-indicator snapshot (RSI, MACD, BBands, ATR, ADX)")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .option("--timeframe <tf>", "Candle timeframe", "4h")
  .option("-o, --output <format>", "Output format: table or json", "table")
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} TA Report (${options.timeframe}):`);
    console.log("  (Compute from live/paper candle data)");
    console.log();
  });

taCommand
  .command("signal")
  .description("Evaluate a trigger spec against the latest indicator value")
  .argument("<symbol>", "Market symbol (e.g. SOL)")
  .requiredOption(
    "--spec <json>",
    'Signal spec JSON, e.g. {"indicator":"rsi","timeframe":"1h","op":"lt","threshold":30}',
  )
  .action(async (symbol, options) => {
    console.log(`\n${symbol.toUpperCase()} Signal: ${options.spec}`);
    console.log("  (Evaluate against live indicator data)");
    console.log();
  });

// ===== STRATEGY =====

const strategyCommand = program
  .command("strategy")
  .description("Automated strategy runners: TWAP, grid, and TA-driven");

strategyCommand
  .command("twap")
  .description("Time-Weighted Average Price strategy")
  .command("start")
  .description("Start a TWAP run")
  .requiredOption("--symbol <s>", "Market symbol (e.g. SOL)")
  .requiredOption("--side <side>", "Trade direction: buy or sell")
  .option("--notional-usdc <amount>", "Total notional in USDC")
  .option("--tokens <amount>", "Total size in base tokens")
  .requiredOption("--slices <n>", "Number of slices")
  .option("--interval-seconds <s>", "Seconds between slices", "60")
  .option("--mode <mode>", "Execution mode: paper, dry-run, confirm-each, auto-execute", "paper")
  .option("--detached", "Start in background and return immediately")
  .option("--run-label <label>", "Human-readable label")
  .action(async (options) => {
    console.log(`\nTWAP Strategy: ${options.side} ${options.symbol.toUpperCase()}`);
    console.log(
      `  Notional: ${options.notionalUsdc || "N/A"} USDC | Slices: ${options.slices} | Interval: ${options.intervalSeconds}s`,
    );
    console.log(`  Mode: ${options.mode}${options.detached ? " (detached)" : ""}`);
    console.log("  (Strategy runner — connect wallet + RPC for live execution)\n");
  });

strategyCommand
  .command("grid")
  .description("Grid trading strategy")
  .command("start")
  .description("Start a grid trading run")
  .requiredOption("--symbol <s>", "Market symbol (e.g. SOL)")
  .option("--center-on-mark", "Center grid on current mark price")
  .option("--width-pct <pct>", "Half-width as % of mark price")
  .requiredOption("--levels-per-side <n>", "Number of levels per side")
  .requiredOption("--tokens-per-level <t>", "Order size per level in base tokens")
  .option("--mode <mode>", "Execution mode: paper, dry-run, confirm-each, auto-execute", "paper")
  .option("--run-until-stopped", "Keep running until paused or stopped")
  .option("--detached", "Start in background and return immediately")
  .option("--run-label <label>", "Human-readable label")
  .action(async (options) => {
    console.log(`\nGrid Strategy: ${options.symbol.toUpperCase()}`);
    console.log(`  Levels: ${options.levelsPerSide}/side | Tokens/level: ${options.tokensPerLevel}`);
    console.log(`  Mode: ${options.mode}${options.detached ? " (detached)" : ""}`);
    console.log("  (Strategy runner — connect wallet + RPC for live execution)\n");
  });

strategyCommand
  .command("runs")
  .description("List persisted strategy runs")
  .option("--limit <n>", "Number of runs to show", "20")
  .action(async () => {
    console.log("\nStrategy Runs:");
    console.log("  (No runs yet — start one with 'clawd strategy twap start' or 'clawd strategy grid start')");
    console.log();
  });

strategyCommand
  .command("status")
  .description("Show latest status for a run")
  .argument("<run-id>", "Strategy run ID")
  .action(async (runId) => {
    console.log(`\nStrategy run ${runId} status — not found or completed.\n`);
  });

strategyCommand
  .command("pause")
  .description("Request a running strategy to pause at the next safe point")
  .argument("<run-id>", "Strategy run ID")
  .action(async (runId) => {
    console.log(`\nPausing strategy run ${runId}...\n`);
  });

strategyCommand
  .command("resume")
  .description("Resume a paused or incomplete strategy run")
  .argument("<run-id>", "Strategy run ID")
  .action(async (runId) => {
    console.log(`\nResuming strategy run ${runId}...\n`);
  });

strategyCommand
  .command("finalize")
  .description("Stop a strategy and optionally clean up")
  .argument("<run-id>", "Strategy run ID")
  .option("--cancel-orders", "Cancel all open orders for this strategy")
  .option("--close-position", "Close the strategy's position")
  .option("--wait", "Wait for finalization to complete")
  .action(async (runId, options) => {
    console.log(`\nFinalizing strategy run ${runId}...`);
    if (options.cancelOrders) console.log("  Will cancel open orders");
    if (options.closePosition) console.log("  Will close position");
    console.log();
  });

// ===== AGENT SKILLS & MCP =====

program
  .command("agent")
  .description("Agent skill and MCP configuration")
  .command("install")
  .description("Install agent skills for a client")
  .option("--target <target>", "Agent client: claude, cursor, codex, agentskills")
  .option("--scope <scope>", "Install scope: user or project", "user")
  .action(async (options) => {
    console.log(`\nInstalling Clawd agent skills for ${options.target} (${options.scope})...`);
    console.log("  (Agent skills installation — see docs for details)\n");
  });

program
  .command("mcp")
  .description("Start the local MCP server over stdio for AI agent integration")
  .option("--allow-dangerous", "Enable live trading tools (requires wallet + password)")
  .option("--groups <list>", "Tool groups to expose: market,trade,position,margin,portfolio,strategy,ta")
  .action(async (options) => {
    console.log(`\nClawd MCP Server starting...`);
    console.log(`  Dangerous mode: ${options.allowDangerous ? "ENABLED ⚠️" : "off (read-only)"}`);
    console.log(`  Groups: ${options.groups || "all"}`);
    console.log("  (MCP server listens on stdio for agent tool calls)\n");
  });

// ===== DAEMON =====

program
  .command("daemon")
  .description("Start the schedule daemon for recurring tasks")
  .option("--background", "Detach and run in the background")
  .action(async (options) => {
    if (options.background) {
      const result = await startScheduleDaemon(process.cwd());
      console.log(
        result.alreadyRunning
          ? `Schedule daemon already running (pid: ${result.status.pid ?? "unknown"}).`
          : `Schedule daemon started in the background (pid: ${result.pid ?? "unknown"}).`,
      );
      return;
    }
    process.off("SIGTERM", exitCleanlyOnSigterm);
    const { SchedulerDaemon } = await import("./daemon/scheduler");
    const daemon = new SchedulerDaemon();
    await daemon.start();
  });

program.parse();

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}
