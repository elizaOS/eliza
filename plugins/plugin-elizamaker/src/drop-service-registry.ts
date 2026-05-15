import type { DropService } from "./drop-service.js";

let activeDropService: DropService | null = null;

export function setElizaMakerDropService(service: DropService | null): void {
  activeDropService = service;
}

export function getElizaMakerDropService(): DropService | null {
  return activeDropService;
}
