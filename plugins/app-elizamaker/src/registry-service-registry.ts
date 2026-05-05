import type { RegistryService } from "@elizaos/agent/api/registry-service";

let activeRegistryService: RegistryService | null = null;

export function setElizaMakerRegistryService(
  service: RegistryService | null,
): void {
  activeRegistryService = service;
}

export function getElizaMakerRegistryService(): RegistryService | null {
  return activeRegistryService;
}
