import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, type Plugin, stringToUuid } from "@elizaos/core";
import {
  createRealTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { appLifeOpsPlugin } from "../../../plugins/app-lifeops/src/plugin.ts";
import {
  MOCK_ENVIRONMENTS,
  type MockEnvironmentName,
  type StartedMocks,
  startMocks,
} from "../scripts/start-mocks.ts";
import { createBenchmarkRuntimeFixturesEnvironment } from "./benchmark-runtime-fixtures.ts";
import {
  createLifeOpsSimulatorRuntimeFixtures,
  type LifeOpsSimulatorSeedResult,
  seedLifeOpsSimulatorRuntime,
} from "./lifeops-simulator.ts";
import { seedBenchmarkLifeOpsFixtures } from "./seed-benchmark-fixtures.ts";
import {
  seedGoogleConnectorGrant,
  seedXConnectorGrant,
} from "./seed-grants.ts";
import { seedTestUserProfile } from "./seed-test-user-profile.ts";

export interface MockedTestRuntime {
  runtime: RealTestRuntimeResult["runtime"];
  mocks: StartedMocks;
  simulator?: LifeOpsSimulatorSeedResult;
  cleanup(): Promise<void>;
}

export interface MockedTestEnvironment {
  mocks: StartedMocks;
  envVars: Record<string, string>;
  seedLifeOpsSimulator: boolean;
  applyRuntimeFixtures?(
    runtime: RealTestRuntimeResult["runtime"],
  ): Promise<(() => Promise<void> | void) | void>;
  cleanup(): Promise<void>;
}

interface MockRuntimeStateEnvironment {
  envVars: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface MockedTestRuntimeOptions {
  /** Subset of mocks to enable. Defaults to all. */
  envs?: readonly MockEnvironmentName[];
  /**
   * Whether to seed a fake Google connector grant. Defaults to true when the
   * `google` environment is enabled.
   */
  seedGoogle?: boolean;
  /**
   * Whether to seed a fake X connector grant. Defaults to true when the
   * `x-twitter` environment is enabled.
   */
  seedX?: boolean;
  /**
   * Whether to seed local LifeOps benchmark fixtures such as relationships and
   * screen-time history. Defaults to true.
   */
  seedBenchmarkFixtures?: boolean;
  /**
   * Seed a full cross-channel LifeOps simulator persona. Defaults to false so
   * provider contract tests can keep using their small exact fixtures.
   */
  seedLifeOpsSimulator?: boolean;
  /** Pass-through to the underlying real-runtime factory. */
  withLLM?: boolean;
  plugins?: Plugin[];
  preferredProvider?: RealTestRuntimeOptions["preferredProvider"];
  sharedEnvironment?: MockedTestEnvironment;
}

const FAKE_CREDS: Readonly<Record<string, string>> = {
  // Twilio
  TWILIO_ACCOUNT_SID: "ACtest1234567890123456789012345678",
  TWILIO_AUTH_TOKEN: "fake-auth-token",
  TWILIO_PHONE_NUMBER: "+15555550000",
  // WhatsApp
  ELIZA_WHATSAPP_ACCESS_TOKEN: "fake-whatsapp-token",
  ELIZA_WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  ELIZA_WHATSAPP_API_VERSION: "v21.0",
  // Calendly
  ELIZA_CALENDLY_TOKEN: "fake-calendly-token",
  // X / Twitter
  TWITTER_API_KEY: "fake-x-key",
  TWITTER_API_SECRET_KEY: "fake-x-secret",
  TWITTER_ACCESS_TOKEN: "fake-x-access-token",
  TWITTER_ACCESS_TOKEN_SECRET: "fake-x-access-secret",
  TWITTER_USER_ID: "1234567890",
};

function mockRuntimePlugins(plugins: readonly Plugin[] | undefined): Plugin[] {
  const out: Plugin[] = [appLifeOpsPlugin];
  const seen = new Set(out.map((plugin) => plugin.name));
  for (const plugin of plugins ?? []) {
    if (seen.has(plugin.name)) continue;
    seen.add(plugin.name);
    out.push(plugin);
  }
  return out;
}

function snapshotAndApply(
  vars: Record<string, string>,
): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  return previous;
}

function restore(previous: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function installMessageConnectionGuard(
  runtime: RealTestRuntimeResult["runtime"],
): () => void {
  const originalCreateMemory = runtime.createMemory.bind(runtime);
  const messageService = runtime.messageService as
    | {
        handleMessage?: (...args: unknown[]) => Promise<unknown>;
      }
    | undefined;
  const ensureMessageConnection = async (message: {
    entityId?: string;
    roomId?: string;
    metadata?: Record<string, unknown>;
    content?: {
      source?: string;
      channelType?: ChannelType;
      name?: string;
    };
  }) => {
    if (!message?.entityId || !message.roomId) return;
    const source = message.content?.source ?? "test";
    const entityName =
      typeof message.metadata?.entityName === "string"
        ? message.metadata.entityName
        : typeof message.content?.name === "string"
          ? message.content.name
          : "Test User";
    await runtime.ensureConnection({
      entityId: message.entityId,
      roomId: message.roomId,
      worldId: stringToUuid(`mocked-runtime:${source}:world`),
      worldName: source,
      userName: entityName,
      name: entityName,
      source,
      type: message.content?.channelType ?? ChannelType.DM,
      channelId: message.roomId,
    });
  };

  runtime.createMemory = (async (memory: unknown, tableName: string) => {
    const candidate = memory as {
      entityId?: string;
      roomId?: string;
      metadata?: Record<string, unknown>;
      content?: {
        source?: string;
        channelType?: ChannelType;
        name?: string;
      };
    };
    if (tableName === "messages") {
      await ensureMessageConnection(candidate);
    }
    return await originalCreateMemory(memory as never, tableName);
  }) as typeof runtime.createMemory;

  if (typeof messageService?.handleMessage !== "function") {
    return () => {
      runtime.createMemory = originalCreateMemory;
    };
  }

  const original = messageService.handleMessage.bind(messageService);
  messageService.handleMessage = async (...args: unknown[]) => {
    const message = args[1] as
      | {
          entityId?: string;
          roomId?: string;
          metadata?: Record<string, unknown>;
          content?: {
            source?: string;
            channelType?: ChannelType;
          };
        }
      | undefined;
    await ensureMessageConnection(message ?? {});
    return original(...args);
  };

  return () => {
    messageService.handleMessage = original;
    runtime.createMemory = originalCreateMemory;
  };
}

function createMockRuntimeStateEnvironment(): MockRuntimeStateEnvironment {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-mock-state-"));
  const configPath = path.join(stateDir, "eliza.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ui: { ownerName: "admin" } }, null, 2),
    "utf8",
  );

  return {
    envVars: {
      ELIZA_STATE_DIR: stateDir,
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_PERSIST_CONFIG_PATH: configPath,
      API_PORT: "0",
    },
    cleanup: async () => {
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function cleanupRuntimeAfterFailure(
  real: RealTestRuntimeResult,
  cleanupRuntimeFixtures: (() => Promise<void> | void) | void,
  localEnvironment: MockedTestEnvironment | null,
): Promise<void> {
  try {
    try {
      await cleanupRuntimeFixtures?.();
    } finally {
      await real.cleanup();
    }
  } finally {
    await localEnvironment?.cleanup();
  }
}

export async function prepareMockedTestEnvironment(
  opts?: Pick<MockedTestRuntimeOptions, "envs" | "seedLifeOpsSimulator">,
): Promise<MockedTestEnvironment> {
  const envs = opts?.envs ?? MOCK_ENVIRONMENTS;
  const seedLifeOpsSimulator = opts?.seedLifeOpsSimulator ?? false;
  const mocks = await startMocks({ envs, simulator: seedLifeOpsSimulator });
  const benchmarkFixtures = await createBenchmarkRuntimeFixturesEnvironment();
  const simulatorFixtures = seedLifeOpsSimulator
    ? createLifeOpsSimulatorRuntimeFixtures()
    : null;
  const mockRuntimeState = createMockRuntimeStateEnvironment();
  const envVars = {
    ...mocks.envVars,
    ...benchmarkFixtures.envVars,
    ...mockRuntimeState.envVars,
    ...FAKE_CREDS,
  };
  const previous = snapshotAndApply(envVars);

  return {
    mocks,
    envVars,
    seedLifeOpsSimulator,
    applyRuntimeFixtures: async (runtime) => {
      const cleanups: Array<(() => Promise<void> | void) | void> = [];
      try {
        cleanups.push(installMessageConnectionGuard(runtime));
        cleanups.push(await benchmarkFixtures.applyRuntimeFixtures(runtime));
        if (simulatorFixtures) {
          cleanups.push(await simulatorFixtures.applyRuntimeFixtures(runtime));
        }
      } catch (err) {
        for (const cleanup of cleanups.reverse()) {
          await cleanup?.();
        }
        throw err;
      }
      return async () => {
        for (const cleanup of cleanups.reverse()) {
          await cleanup?.();
        }
      };
    },
    cleanup: async () => {
      try {
        try {
          await benchmarkFixtures.cleanup();
        } finally {
          await mocks.stop();
        }
      } finally {
        restore(previous);
        await mockRuntimeState.cleanup();
      }
    },
  };
}

export async function createMockedTestRuntime(
  opts?: MockedTestRuntimeOptions,
): Promise<MockedTestRuntime> {
  const envs = opts?.envs ?? MOCK_ENVIRONMENTS;
  const sharedEnvironment = opts?.sharedEnvironment;
  const localEnvironment = sharedEnvironment
    ? null
    : await prepareMockedTestEnvironment({
        envs,
        seedLifeOpsSimulator: opts?.seedLifeOpsSimulator,
      });
  const environment = sharedEnvironment ?? localEnvironment;
  if (!environment) {
    throw new Error(
      "createMockedTestRuntime: expected sharedEnvironment or localEnvironment to be available",
    );
  }
  if (opts?.seedLifeOpsSimulator && !environment.seedLifeOpsSimulator) {
    await localEnvironment?.cleanup();
    throw new Error(
      "createMockedTestRuntime: seedLifeOpsSimulator requires a simulator-enabled mocked environment",
    );
  }
  const mocks = environment.mocks;
  let cleanupRuntimeFixtures: (() => Promise<void> | void) | void;

  let real: RealTestRuntimeResult;
  try {
    real = await createRealTestRuntime({
      withLLM: opts?.withLLM ?? false,
      plugins: mockRuntimePlugins(opts?.plugins),
      preferredProvider: opts?.preferredProvider,
    });
    cleanupRuntimeFixtures = await environment.applyRuntimeFixtures?.(
      real.runtime,
    );
  } catch (err) {
    await localEnvironment?.cleanup();
    throw err;
  }

  const shouldSeedGoogle =
    (opts?.seedGoogle ?? true) && envs.includes("google");
  const shouldSeedX = (opts?.seedX ?? true) && envs.includes("x-twitter");
  const shouldSeedBenchmarkFixtures = opts?.seedBenchmarkFixtures ?? true;
  if (shouldSeedGoogle || shouldSeedX || shouldSeedBenchmarkFixtures) {
    try {
      if (shouldSeedGoogle) {
        await seedGoogleConnectorGrant(real.runtime);
      }
      if (shouldSeedX) {
        await seedXConnectorGrant(real.runtime, { side: "owner" });
        await seedXConnectorGrant(real.runtime, {
          side: "agent",
          handle: "@mocked-lifeops-agent",
        });
      }
      if (shouldSeedBenchmarkFixtures) {
        await seedBenchmarkLifeOpsFixtures(real.runtime);
      }
    } catch (err) {
      await cleanupRuntimeAfterFailure(
        real,
        cleanupRuntimeFixtures,
        localEnvironment,
      );
      throw err;
    }
  }

  if (process.env.LOAD_TEST_USER_PROFILE === "1") {
    try {
      await seedTestUserProfile(real.runtime);
    } catch (err) {
      await cleanupRuntimeAfterFailure(
        real,
        cleanupRuntimeFixtures,
        localEnvironment,
      );
      throw err;
    }
  }

  let simulator: LifeOpsSimulatorSeedResult | undefined;
  if (opts?.seedLifeOpsSimulator) {
    try {
      simulator = await seedLifeOpsSimulatorRuntime(real.runtime);
    } catch (err) {
      await cleanupRuntimeAfterFailure(
        real,
        cleanupRuntimeFixtures,
        localEnvironment,
      );
      throw err;
    }
  }

  return {
    runtime: real.runtime,
    mocks,
    ...(simulator ? { simulator } : {}),
    cleanup: async () => {
      try {
        await cleanupRuntimeFixtures?.();
        await real.cleanup();
      } finally {
        await localEnvironment?.cleanup();
      }
    },
  };
}
