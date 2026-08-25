/**
 * Behavioral coverage for first-run topology, cloud-wallet env binding, and
 * the CLI first-time-setup short-circuits. Drives the real module: cloud vs
 * local vs hybrid routing, empty config, missing wallet descriptors, primary
 * selection ties, and TTY vs named-agent skip paths. Interactive prompts are
 * stubbed at the clack / cloud-setup boundary only.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  getStylePresets,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigEnv } from "../api/config-env.ts";
import {
  CLOUD_EVM_ADDRESS_ENV_KEY,
  CLOUD_SOLANA_ADDRESS_ENV_KEY,
  WALLET_SOURCE_EVM_ENV_KEY,
  WALLET_SOURCE_SOLANA_ENV_KEY,
} from "../api/wallet.ts";
import type { ElizaConfig } from "../config/config.ts";
import {
  applyFirstTimeSetupTopology,
  bindCloudProvider,
  runFirstTimeSetup,
} from "./first-time-setup.ts";

const CANCEL = Symbol("clack-cancel");
const EVM_ADDRESS = "0xabc0000000000000000000000000000000000001";
const SOLANA_ADDRESS = "CloudSolAddr11111111111111111111111111111";
const ALT_EVM_ADDRESS = "0xdef0000000000000000000000000000000000002";

const clackMocks = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === CANCEL),
  log: {
    message: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const cloudSetup = vi.hoisted(() => ({
  runCloudSetup: vi.fn(),
  ClackObserver: class ClackObserver {},
}));

vi.mock("@clack/prompts", () => ({
  intro: clackMocks.intro,
  outro: clackMocks.outro,
  cancel: clackMocks.cancel,
  select: clackMocks.select,
  text: clackMocks.text,
  password: clackMocks.password,
  isCancel: clackMocks.isCancel,
  log: clackMocks.log,
}));

vi.mock("@elizaos/plugin-elizacloud", () => ({
  runCloudSetup: cloudSetup.runCloudSetup,
  ClackObserver: cloudSetup.ClackObserver,
}));

const ENV_KEYS = [
  "ENABLE_CLOUD_WALLET",
  "ELIZA_STATE_DIR",
  CLOUD_EVM_ADDRESS_ENV_KEY,
  CLOUD_SOLANA_ADDRESS_ENV_KEY,
  WALLET_SOURCE_EVM_ENV_KEY,
  WALLET_SOURCE_SOLANA_ENV_KEY,
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "GITHUB_OAUTH_CLIENT_ID",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "NEARAI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

let stateDir: string;
let envSnapshot: NodeJS.ProcessEnv;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    value,
  });
}

function cloudWalletConfig(overrides: ElizaConfig = {}): ElizaConfig {
  return {
    wallet: {
      cloud: {
        evm: { walletAddress: EVM_ADDRESS },
        solana: { walletAddress: SOLANA_ADDRESS },
      },
    },
    ...overrides,
  };
}

function queueSelect(values: unknown[]): void {
  const queue = [...values];
  clackMocks.select.mockImplementation(async () => {
    if (queue.length === 0) {
      throw new Error("clack.select called with an empty answer queue");
    }
    return queue.shift();
  });
}

function queueText(values: unknown[]): void {
  const queue = [...values];
  clackMocks.text.mockImplementation(async () => {
    if (queue.length === 0) {
      throw new Error("clack.text called with an empty answer queue");
    }
    return queue.shift();
  });
}

beforeEach(async () => {
  envSnapshot = { ...process.env };
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-first-time-setup-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  for (const key of ENV_KEYS) {
    if (key !== "ELIZA_STATE_DIR") delete process.env[key];
  }
  setStdinTTY(false);
  clackMocks.intro.mockReset();
  clackMocks.outro.mockReset();
  clackMocks.cancel.mockReset();
  clackMocks.select.mockReset();
  clackMocks.text.mockReset();
  clackMocks.password.mockReset();
  clackMocks.isCancel.mockReset();
  clackMocks.isCancel.mockImplementation((value: unknown) => value === CANCEL);
  clackMocks.log.message.mockReset();
  clackMocks.log.success.mockReset();
  clackMocks.log.info.mockReset();
  clackMocks.log.warn.mockReset();
  cloudSetup.runCloudSetup.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(stateDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  if (stdinDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  } else {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
  }
});

describe("applyFirstTimeSetupTopology", () => {
  it("returns local deployment and omits empty linked-account and routing maps", () => {
    const input: ElizaConfig = { ui: { theme: "eliza" } };
    const result = applyFirstTimeSetupTopology(input, {
      isCloudRuntime: false,
    });
    expect(result).toEqual({
      ui: { theme: "eliza" },
      deploymentTarget: { runtime: "local" },
    });
    expect(result).not.toBe(input);
    expect(input.deploymentTarget).toBeUndefined();
  });

  it("marks elizacloud linked only when the first-run API key is non-blank", () => {
    const withKey = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        cloudFirstRunResult: {
          apiKey: "  sk-live  ",
          agentId: undefined,
          baseUrl: "https://api.eliza.example",
        },
      },
    );
    expect(withKey.linkedAccounts).toEqual({
      elizacloud: { status: "linked", source: "oauth" },
    });

    const blankKey = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        cloudFirstRunResult: {
          apiKey: "   ",
          agentId: undefined,
          baseUrl: "https://api.eliza.example",
        },
      },
    );
    expect(blankKey.linkedAccounts).toBeUndefined();
  });

  it("preserves existing linked accounts when no cloud API key is present", () => {
    const result = applyFirstTimeSetupTopology(
      {
        linkedAccounts: {
          "openai-api": { status: "linked", source: "api-key" },
        },
      },
      { isCloudRuntime: false },
    );
    expect(result.linkedAccounts).toEqual({
      "openai-api": { status: "linked", source: "api-key" },
    });
  });

  it("routes elizacloud inference through the shared cloud-proxy builder", () => {
    const result = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        selectedProviderId: "elizacloud",
      },
    );
    const expectedRouting = buildDefaultElizaCloudServiceRouting({
      base: { llmText: buildElizaCloudServiceRoute() },
      includeInference: true,
      excludeServices: ["embeddings"],
    });
    expect(result.deploymentTarget).toEqual({ runtime: "local" });
    expect(result.serviceRouting).toEqual(expectedRouting);
    expect(result.serviceRouting?.embeddings).toBeUndefined();
    expect(result.serviceRouting?.llmText).toEqual(
      buildElizaCloudServiceRoute(),
    );
  });

  it("trims a direct provider id and does not attach cloud sidecar routes", () => {
    const result = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        selectedProviderId: "  anthropic  ",
      },
    );
    expect(result.serviceRouting).toEqual({
      llmText: { backend: "anthropic", transport: "direct" },
    });
    expect(result.serviceRouting?.tts).toBeUndefined();
  });

  it("treats a whitespace-only provider as missing rather than a backend id", () => {
    const result = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        selectedProviderId: "   ",
      },
    );
    expect(result.serviceRouting).toBeUndefined();
  });

  it("keeps a local agent's existing embeddings while filling other cloud services for a cloud runtime", () => {
    const existingEmbeddings = {
      backend: "local-onnx",
      transport: "direct" as const,
    };
    const result = applyFirstTimeSetupTopology(
      { serviceRouting: { embeddings: existingEmbeddings } },
      {
        isCloudRuntime: true,
        selectedProviderId: "openai",
      },
    );
    const expectedRouting = buildDefaultElizaCloudServiceRouting({
      base: {
        embeddings: existingEmbeddings,
        llmText: { backend: "openai", transport: "direct" },
      },
      includeInference: false,
    });
    expect(result.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(result.serviceRouting).toEqual(expectedRouting);
    expect(result.serviceRouting?.embeddings).toEqual(existingEmbeddings);
    expect(result.serviceRouting?.llmText).toEqual({
      backend: "openai",
      transport: "direct",
    });
  });

  it("overwrites an existing llmText route when a provider is selected", () => {
    const result = applyFirstTimeSetupTopology(
      {
        serviceRouting: {
          llmText: { backend: "groq", transport: "direct" },
        },
      },
      {
        isCloudRuntime: false,
        selectedProviderId: "openai",
      },
    );
    expect(result.serviceRouting?.llmText).toEqual({
      backend: "openai",
      transport: "direct",
    });
  });

  it("persists cloud credentials and optional agentId without dropping prior cloud fields", () => {
    const withAgent = applyFirstTimeSetupTopology(
      { cloud: { enabled: true, provider: "elizacloud" } },
      {
        isCloudRuntime: true,
        cloudFirstRunResult: {
          apiKey: "sk-live",
          agentId: "agent-123",
          baseUrl: "https://api.eliza.example",
        },
      },
    );
    expect(withAgent.cloud).toEqual({
      enabled: true,
      provider: "elizacloud",
      apiKey: "sk-live",
      baseUrl: "https://api.eliza.example",
      agentId: "agent-123",
    });

    const withoutAgent = applyFirstTimeSetupTopology(
      {},
      {
        isCloudRuntime: false,
        cloudFirstRunResult: {
          apiKey: "sk-live",
          agentId: "",
          baseUrl: "https://api.eliza.example",
        },
      },
    );
    expect(withoutAgent.cloud).toEqual({
      apiKey: "sk-live",
      baseUrl: "https://api.eliza.example",
    });
    expect(withoutAgent.cloud).not.toHaveProperty("agentId");
  });

  it("leaves config.cloud untouched when first-run produced no cloud result", () => {
    const result = applyFirstTimeSetupTopology(
      { cloud: { enabled: false, baseUrl: "https://kept.example" } },
      { isCloudRuntime: false },
    );
    expect(result.cloud).toEqual({
      enabled: false,
      baseUrl: "https://kept.example",
    });
  });
});

describe("bindCloudProvider", () => {
  it("returns without writing when the cloud-wallet flag is off", async () => {
    await bindCloudProvider(cloudWalletConfig());
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBeUndefined();
    expect(await readConfigEnv(stateDir)).toEqual({});
  });

  it("returns without writing when the cloud wallet cache is empty", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider({ wallet: { cloud: {} } });
    await bindCloudProvider({ wallet: { rpcProviders: {} } });
    await bindCloudProvider({});
    expect(await readConfigEnv(stateDir)).toEqual({});
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBeUndefined();
  });

  it("binds both chains from walletAddress descriptors when the user has not chosen local", async () => {
    process.env.ENABLE_CLOUD_WALLET = "true";
    await bindCloudProvider(cloudWalletConfig());
    expect(process.env[CLOUD_EVM_ADDRESS_ENV_KEY]).toBe(EVM_ADDRESS);
    expect(process.env[CLOUD_SOLANA_ADDRESS_ENV_KEY]).toBe(SOLANA_ADDRESS);
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBe("cloud");
    expect(process.env[WALLET_SOURCE_SOLANA_ENV_KEY]).toBe("cloud");
    expect(await readConfigEnv(stateDir)).toEqual({
      [CLOUD_EVM_ADDRESS_ENV_KEY]: EVM_ADDRESS,
      [CLOUD_SOLANA_ADDRESS_ENV_KEY]: SOLANA_ADDRESS,
      [WALLET_SOURCE_EVM_ENV_KEY]: "cloud",
      [WALLET_SOURCE_SOLANA_ENV_KEY]: "cloud",
    });
  });

  it("falls back to descriptor.address when walletAddress is absent", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider({
      wallet: {
        cloud: {
          evm: { address: `  ${ALT_EVM_ADDRESS}  ` },
        },
      },
    });
    expect(process.env[CLOUD_EVM_ADDRESS_ENV_KEY]).toBe(ALT_EVM_ADDRESS);
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBe("cloud");
    expect(process.env[WALLET_SOURCE_SOLANA_ENV_KEY]).toBeUndefined();
  });

  it("prefers walletAddress over address when both are present", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider({
      wallet: {
        cloud: {
          evm: {
            walletAddress: EVM_ADDRESS,
            address: ALT_EVM_ADDRESS,
          },
        },
      },
    });
    expect(process.env[CLOUD_EVM_ADDRESS_ENV_KEY]).toBe(EVM_ADDRESS);
  });

  it("does not persist a whitespace-only address but still marks the source cloud", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider({
      wallet: {
        cloud: {
          evm: { walletAddress: "   " },
        },
      },
    });
    expect(process.env[CLOUD_EVM_ADDRESS_ENV_KEY]).toBeUndefined();
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBe("cloud");
  });

  it("skips a chain whose user primary selection is local", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    await bindCloudProvider(
      cloudWalletConfig({
        wallet: {
          primary: { evm: "local", solana: "cloud" },
          cloud: {
            evm: { walletAddress: EVM_ADDRESS },
            solana: { walletAddress: SOLANA_ADDRESS },
          },
        },
      }),
    );
    expect(process.env[CLOUD_EVM_ADDRESS_ENV_KEY]).toBeUndefined();
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBeUndefined();
    expect(process.env[CLOUD_SOLANA_ADDRESS_ENV_KEY]).toBe(SOLANA_ADDRESS);
    expect(process.env[WALLET_SOURCE_SOLANA_ENV_KEY]).toBe("cloud");
  });

  it("treats an unrecognized primary value as unset and still auto-binds", async () => {
    process.env.ENABLE_CLOUD_WALLET = "yes";
    await bindCloudProvider({
      wallet: {
        primary: { evm: "hardware" as "cloud", solana: "usb" as "local" },
        cloud: {
          evm: { walletAddress: EVM_ADDRESS },
          solana: { walletAddress: SOLANA_ADDRESS },
        },
      },
    });
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBe("cloud");
    expect(process.env[WALLET_SOURCE_SOLANA_ENV_KEY]).toBe("cloud");
  });

  it("does not rewrite env when the cloud address and source already match", async () => {
    process.env.ENABLE_CLOUD_WALLET = "on";
    process.env[CLOUD_EVM_ADDRESS_ENV_KEY] = EVM_ADDRESS;
    process.env[WALLET_SOURCE_EVM_ENV_KEY] = "cloud";
    await bindCloudProvider({
      wallet: {
        cloud: { evm: { walletAddress: EVM_ADDRESS } },
      },
    });
    expect(await readConfigEnv(stateDir)).toEqual({});
  });
});

describe("runFirstTimeSetup", () => {
  it("rebinds cloud wallets for a named agent even when stdin is not a TTY", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = cloudWalletConfig({
      agents: { list: [{ id: "main", name: "Sakuya" }] },
    });
    const result = await runFirstTimeSetup(config);
    expect(result).toBe(config);
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBe("cloud");
    expect(clackMocks.intro).not.toHaveBeenCalled();
  });

  it("treats ui.assistant.name as already configured", async () => {
    const config: ElizaConfig = {
      ui: { assistant: { name: "Marisa" } },
    };
    const result = await runFirstTimeSetup(config);
    expect(result).toBe(config);
    expect(clackMocks.select).not.toHaveBeenCalled();
  });

  it("does not bind cloud wallets on a nameless non-TTY process", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = cloudWalletConfig();
    const result = await runFirstTimeSetup(config);
    expect(result).toBe(config);
    expect(process.env[WALLET_SOURCE_EVM_ENV_KEY]).toBeUndefined();
    expect(await readConfigEnv(stateDir)).toEqual({});
  });

  it("persists a local first-run with style, skipped provider, and skipped wallets", async () => {
    setStdinTTY(true);
    const presets = getStylePresets();
    const chosen = presets[0];
    expect(chosen).toBeDefined();
    if (!chosen) throw new Error("expected at least one style preset");
    queueSelect(["Sakuya", chosen.id, "later", "_skip_", "skip", "skip"]);

    const result = await runFirstTimeSetup({
      agents: { list: [{ id: "side", default: false }] },
    });

    expect(result.agents?.list?.[0]).toEqual(
      expect.objectContaining({
        id: "side",
        default: false,
        name: "Sakuya",
        bio: chosen.bio,
        system: chosen.system,
        style: chosen.style,
        adjectives: chosen.adjectives,
        postExamples: chosen.postExamples,
        messageExamples: chosen.messageExamples,
      }),
    );
    expect(result.deploymentTarget).toEqual({ runtime: "local" });
    expect(result.serviceRouting).toBeUndefined();
    const saved = await readFile(path.join(stateDir, "eliza.json"), "utf8");
    expect(saved).toContain("Sakuya");
    expect(clackMocks.outro).toHaveBeenCalledWith("Let's get started!");
  });

  it("falls back to the default style-preset name when custom input is blank", async () => {
    setStdinTTY(true);
    const presets = getStylePresets();
    const chosen = presets[1] ?? presets[0];
    expect(chosen).toBeDefined();
    if (!chosen) throw new Error("expected a style preset");
    const defaultName = presets[0]?.name ?? "Eliza";
    queueSelect(["_custom_", chosen.id, "local", "_skip_", "skip", "skip"]);
    queueText(["   "]);

    const result = await runFirstTimeSetup({});
    expect(result.agents?.list?.[0]?.name).toBe(defaultName);
    expect(result.agents?.list?.[0]?.id).toBe("main");
    expect(result.agents?.list?.[0]?.default).toBe(true);
  });

  it("detects an existing provider key and records it on the env bucket", async () => {
    setStdinTTY(true);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const presets = getStylePresets();
    const chosen = presets[0];
    expect(chosen).toBeDefined();
    if (!chosen) throw new Error("expected a style preset");
    queueSelect(["Reimu", chosen.id, "local", "skip", "skip"]);

    const result = await runFirstTimeSetup({});
    expect(result.serviceRouting?.llmText).toEqual({
      backend: "anthropic",
      transport: "direct",
    });
    expect(result.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
  });

  it("applies cloud topology and skips local wallet prompts when cloud setup provisions an agent", async () => {
    setStdinTTY(true);
    const presets = getStylePresets();
    const chosen = presets[0];
    expect(chosen).toBeDefined();
    if (!chosen) throw new Error("expected a style preset");
    cloudSetup.runCloudSetup.mockResolvedValue({
      apiKey: "sk-cloud",
      agentId: "cloud-agent-1",
      baseUrl: "https://api.eliza.example",
    });
    queueSelect(["Yukari", chosen.id, "cloud", "_skip_"]);

    const result = await runFirstTimeSetup({});
    expect(result.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(result.linkedAccounts?.elizacloud).toEqual({
      status: "linked",
      source: "oauth",
    });
    expect(result.cloud).toEqual({
      apiKey: "sk-cloud",
      baseUrl: "https://api.eliza.example",
      agentId: "cloud-agent-1",
    });
    expect(result.serviceRouting?.embeddings).toEqual(
      buildElizaCloudServiceRoute(),
    );
    expect(clackMocks.select).toHaveBeenCalledTimes(4);
    expect(clackMocks.outro).toHaveBeenCalledWith(
      "Your agent is live in the cloud! ☁️",
    );
  });

  it("falls back to local setup when cloud first-run returns nothing", async () => {
    setStdinTTY(true);
    const presets = getStylePresets();
    const chosen = presets[0];
    expect(chosen).toBeDefined();
    if (!chosen) throw new Error("expected a style preset");
    cloudSetup.runCloudSetup.mockResolvedValue(null);
    queueSelect(["Youmu", chosen.id, "cloud", "_skip_", "skip", "skip"]);

    const result = await runFirstTimeSetup({});
    expect(result.deploymentTarget).toEqual({ runtime: "local" });
    expect(result.linkedAccounts).toBeUndefined();
    expect(clackMocks.select).toHaveBeenCalledTimes(6);
    expect(clackMocks.log.info).toHaveBeenCalledWith(
      "No worries! Setting up locally instead.",
    );
  });

  it("cancels cleanly when the user aborts the name prompt", async () => {
    setStdinTTY(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    queueSelect([CANCEL]);

    await expect(runFirstTimeSetup({})).rejects.toThrow("exit:0");
    expect(clackMocks.cancel).toHaveBeenCalledWith("Maybe next time!");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
