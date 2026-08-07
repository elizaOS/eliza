/**
 * Boots ComputerUseService through a real AgentRuntime backed by the in-memory
 * database adapter. The harness never dispatches host actions; each caller
 * chooses whether it exercises deterministic validation or opted-in hardware.
 */

import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  stringToUuid,
} from "@elizaos/core";
import { ComputerUseService } from "../../src/services/computer-use-service.js";

/** Starts the service through the same AgentRuntime registration path used in production. */
export async function startComputerUseRuntime(
  settings: Record<string, string> = {},
): Promise<{ runtime: AgentRuntime; service: ComputerUseService }> {
  const runtime = new AgentRuntime({
    character: createCharacter({
      id: stringToUuid(`computeruse-service-${crypto.randomUUID()}`),
      name: "ComputerUseServiceTestAgent",
      settings,
    }),
    adapter: new InMemoryDatabaseAdapter(),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
    logLevel: "fatal",
  });
  await runtime.initialize();
  const previousDriver = process.env.ELIZA_COMPUTERUSE_DRIVER;
  process.env.ELIZA_COMPUTERUSE_DRIVER = "legacy";
  try {
    await runtime.registerPlugin({
      name: "computeruse-service-test",
      description: "ComputerUseService runtime test harness",
      services: [ComputerUseService],
    });
  } finally {
    if (previousDriver === undefined) {
      delete process.env.ELIZA_COMPUTERUSE_DRIVER;
    } else {
      process.env.ELIZA_COMPUTERUSE_DRIVER = previousDriver;
    }
  }
  const service = await runtime.getServiceLoadPromise(
    ComputerUseService.serviceType,
  );
  if (!(service instanceof ComputerUseService)) {
    throw new Error("ComputerUseService did not register with AgentRuntime");
  }
  return { runtime, service };
}

/** Releases runtime resources created by {@link startComputerUseRuntime}. */
export async function stopComputerUseRuntime(
  runtime: AgentRuntime,
): Promise<void> {
  await runtime.stop();
  await runtime.close();
}
