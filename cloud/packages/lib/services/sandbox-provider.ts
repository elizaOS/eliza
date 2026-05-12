import type { SandboxProvider } from "./sandbox-provider-types";

export type {
  SandboxCreateConfig,
  SandboxHandle,
  SandboxProvider,
} from "./sandbox-provider-types";

export async function createSandboxProvider(): Promise<SandboxProvider> {
  const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
  return new DockerSandboxProvider();
}
