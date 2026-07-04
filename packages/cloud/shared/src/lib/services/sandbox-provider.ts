// Coordinates cloud service sandbox provider behavior behind route handlers.
import type { SandboxProvider } from "./sandbox-provider-types";

export type {
  SandboxCreateConfig,
  SandboxHandle,
  SandboxProvider,
} from "./sandbox-provider-types";

/**
 * Pick the sandbox provider implementation.
 *
 * - `LocalDockerSandboxProvider` when:
 *   - `ELIZA_LOCAL_DOCKER_PROVIDER=1`, OR
 *   - `ENVIRONMENT=local` and no SSH key envs are configured
 *     (`CONTAINERS_SSH_KEY`, `CONTAINERS_SSH_KEY_PATH`, `AGENT_SSH_KEY`,
 *     `AGENT_SSH_KEY_PATH`).
 * - `DockerSandboxProvider` (SSH-into-remote-nodes) otherwise.
 */
export async function createSandboxProvider(): Promise<SandboxProvider> {
  if (shouldUseMemoryTestProvider()) {
    const { MemorySandboxProvider } = await import("./memory-sandbox-provider");
    return new MemorySandboxProvider();
  }
  if (shouldUseLocalDockerProvider()) {
    const { LocalDockerSandboxProvider } = await import("./local-docker-sandbox-provider");
    return new LocalDockerSandboxProvider();
  }
  const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
  return new DockerSandboxProvider();
}

function shouldUseMemoryTestProvider(): boolean {
  const env = process.env;
  if (env.ELIZA_TEST_SANDBOX_PROVIDER !== "memory") return false;
  if (env.NODE_ENV === "test" || env.CLOUD_E2E === "1") return true;
  throw new Error(
    "ELIZA_TEST_SANDBOX_PROVIDER=memory is only allowed under NODE_ENV=test or CLOUD_E2E=1",
  );
}

function shouldUseLocalDockerProvider(): boolean {
  const env = process.env;
  if (env.ELIZA_LOCAL_DOCKER_PROVIDER === "1") return true;
  if (env.ENVIRONMENT === "local") {
    const hasSshKey =
      hasValue(env.CONTAINERS_SSH_KEY) ||
      hasValue(env.CONTAINERS_SSH_KEY_PATH) ||
      hasValue(env.AGENT_SSH_KEY) ||
      hasValue(env.AGENT_SSH_KEY_PATH);
    if (!hasSshKey) return true;
  }
  return false;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
