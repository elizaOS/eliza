/** Real applyCloudConfigToEnv across in-process restarts; no mocked services. */

import {
  buildElizaCloudServiceRoute,
  type ElizaConfig,
} from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyCloudConfigToEnv,
  resetLaunchCloudRolePinEnvForTests,
} from "../src/runtime/eliza.ts";

const ROLE_PIN_KEYS = [
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
] as const;
const cloudCredential = ["test", "cloud", "credential"].join("-");

// The llmText that Settings saves: Default leaves a role pin out.
function savedConfig(pins: {
  responseHandlerModel?: string;
  actionPlannerModel?: string;
}): ElizaConfig {
  return {
    cloud: { enabled: true, apiKey: cloudCredential },
    models: {
      nano: "m-nano",
      small: "m-small",
      medium: "m-medium",
      large: "m-large",
      mega: "m-mega",
    },
    serviceRouting: {
      llmText: buildElizaCloudServiceRoute({
        nanoModel: "m-nano",
        smallModel: "m-small",
        mediumModel: "m-medium",
        largeModel: "m-large",
        megaModel: "m-mega",
        ...pins,
      }),
    },
  } as ElizaConfig;
}

const rolePins = () =>
  Object.fromEntries(ROLE_PIN_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  resetLaunchCloudRolePinEnvForTests();
  for (const key of [...ROLE_PIN_KEYS, "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetLaunchCloudRolePinEnvForTests();
});

const custom = {
  responseHandlerModel: "custom/handler",
  actionPlannerModel: "custom/planner",
};

it("clears all four role pins when Settings resets them to Default", () => {
  applyCloudConfigToEnv(savedConfig(custom));
  expect(rolePins()).toEqual({
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "custom/handler",
    ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL: "custom/handler",
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "custom/planner",
    ELIZAOS_CLOUD_PLANNER_MODEL: "custom/planner",
  });
  applyCloudConfigToEnv(savedConfig({})); // in-process restart
  for (const value of Object.values(rolePins())) expect(value).toBeUndefined();
});

it("keeps a role pin that was in the environment before the first apply", () => {
  // The desktop dev server loads dotenv after importing the agent package.
  vi.stubEnv("ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL", "operator/handler");
  applyCloudConfigToEnv(savedConfig({}));
  applyCloudConfigToEnv(savedConfig({}));
  expect(process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
    "operator/handler",
  );
  expect(process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL).toBeUndefined();
});

it("clears a role pin reset to Default in a provisioned Cloud container", () => {
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "1");
  applyCloudConfigToEnv(savedConfig(custom));
  expect(process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
    "custom/handler",
  );
  const reset = savedConfig({});
  applyCloudConfigToEnv(reset);
  for (const value of Object.values(rolePins())) expect(value).toBeUndefined();
  const llmText = reset.serviceRouting?.llmText as Record<string, unknown>;
  expect(llmText.responseHandlerModel).toBeUndefined();
  expect(llmText.actionPlannerModel).toBeUndefined();
});
