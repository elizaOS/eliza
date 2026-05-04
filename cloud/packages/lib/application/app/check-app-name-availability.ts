import type { AppRepository } from "@/lib/domain/app/app-repository";

export class CheckAppNameAvailabilityUseCase {
  constructor(private readonly apps: AppRepository) {}

  execute(name: string): Promise<{ available: boolean; reason?: string }> {
    return this.apps.checkNameAvailability(name);
  }
}
