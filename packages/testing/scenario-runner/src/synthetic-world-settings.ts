/** Derives runtime settings only from registered, local world endpoints. */
import { ElizaError } from "@elizaos/core";
import {
  MOCK_ENVIRONMENTS,
  type MockEnvironmentName,
  mockEnvironmentSettings,
} from "../../scripts/mocks/start-mocks.ts";
import { isLoopbackUrl } from "./utils.ts";

export function syntheticWorldSettings(
  endpoints: unknown,
): Record<string, string> {
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    throw new ElizaError("Synthetic world endpoints must be an object", {
      code: "SYNTHETIC_WORLD_ENDPOINT_INVALID",
    });
  }
  const services: MockEnvironmentName[] = [];
  const urls: Partial<Record<MockEnvironmentName, string>> = {};
  for (const [name, value] of Object.entries(endpoints)) {
    if (
      !MOCK_ENVIRONMENTS.includes(name as MockEnvironmentName) ||
      typeof value !== "string" ||
      !isLoopbackUrl(value)
    ) {
      throw new ElizaError(
        `Synthetic world endpoint ${name} must name a registered service on a credential-free loopback URL`,
        { code: "SYNTHETIC_WORLD_ENDPOINT_INVALID" },
      );
    }
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new ElizaError(
        `Synthetic world endpoint ${name} must be a credential-free origin`,
        { code: "SYNTHETIC_WORLD_ENDPOINT_INVALID" },
      );
    }
    const service = name as MockEnvironmentName;
    services.push(service);
    urls[service] = value;
  }
  if (services.length === 0)
    throw new ElizaError("Synthetic world must declare API endpoints", {
      code: "SYNTHETIC_WORLD_ENDPOINT_INVALID",
    });
  return {
    ELIZA_SYNTHETIC_WORLD_LEASED: "1",
    ...mockEnvironmentSettings(
      services,
      urls as Record<MockEnvironmentName, string>,
    ),
  };
}

export function parseSyntheticWorldConfiguration(serialized: string): {
  endpoints: Record<string, string>;
  settings: Record<string, string>;
} {
  let endpoints: unknown;
  try {
    endpoints = JSON.parse(serialized);
  } catch (cause) {
    throw new ElizaError("Synthetic world endpoints contain invalid JSON", {
      code: "SYNTHETIC_WORLD_ENDPOINT_INVALID",
      cause,
    });
  }
  const settings = syntheticWorldSettings(endpoints);
  return { endpoints: endpoints as Record<string, string>, settings };
}
