import type { AppRepository } from "@/lib/domain/app/app-repository";

export interface AppPageViewInput {
  pageUrl: string;
  referrer?: string;
  ipAddress?: string;
  userAgent?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export class TrackAppPageViewUseCase {
  constructor(private readonly apps: AppRepository) {}

  async execute(appId: string, input: AppPageViewInput): Promise<void> {
    await this.apps.trackPageView(appId, input);
  }
}
