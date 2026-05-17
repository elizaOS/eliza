import { type PersistedActiveServer } from "./persistence";
export interface ExistingOnboardingProbeClient {
  apiAvailable: boolean;
  getOnboardingStatus: () => Promise<{
    complete: boolean;
  }>;
  getConfig: () => Promise<Record<string, unknown> | null | undefined>;
}
export interface ExistingOnboardingProbeResult {
  activeServer: PersistedActiveServer;
  detectedExistingInstall: boolean;
}
export declare function detectExistingOnboardingConnection(args: {
  client: ExistingOnboardingProbeClient;
  timeoutMs: number;
}): Promise<ExistingOnboardingProbeResult | null>;
//# sourceMappingURL=onboarding-bootstrap.d.ts.map
