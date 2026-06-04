import type { SandboxContainerLaunchConfig } from "./sandbox-provider-types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function resolveSandboxContainerLaunchConfig(
  agentConfig: unknown,
): SandboxContainerLaunchConfig | undefined {
  const container = asRecord(asRecord(agentConfig).container);
  const projectName =
    typeof container.projectName === "string" && container.projectName.trim()
      ? container.projectName.trim()
      : undefined;
  const healthCheckPath =
    typeof container.healthCheckPath === "string" &&
    container.healthCheckPath.trim()
      ? container.healthCheckPath.trim()
      : undefined;
  const architecture =
    container.architecture === "arm64" || container.architecture === "x86_64"
      ? container.architecture
      : undefined;
  const port = positiveInteger(container.port);
  const cpu = positiveNumber(container.cpu);
  const memoryMb = positiveNumber(container.memory);
  const desiredCount = positiveInteger(container.desiredCount);
  const next: SandboxContainerLaunchConfig = {
    ...(projectName ? { projectName } : {}),
    ...(port ? { port } : {}),
    ...(cpu ? { cpu } : {}),
    ...(memoryMb ? { memoryMb } : {}),
    ...(desiredCount ? { desiredCount } : {}),
    ...(architecture ? { architecture } : {}),
    ...(healthCheckPath ? { healthCheckPath } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}
