/**
 * Vision opt-in capability gate (SOC2 A-7).
 *
 * Per user feedback `feedback_plugin_vision_cost.md` and the SOC2 audit
 * (CC6.6, PI1.2), vision/image analysis must NEVER be silently active.
 * The gate is closed by default — any analyze call returns a deny error
 * and emits `vision.denied` until the user explicitly enables the
 * preference. UI surfacing the cost warning + consent prompt is the
 * app-views agent's job; this module enforces the service-layer gate.
 */

import type { AuditDispatcher } from "@elizaos/security";
import type {
  MediaProviderResult,
  VisionAnalysisOptions,
  VisionAnalysisProvider,
  VisionAnalysisResult,
} from "../providers/media-provider.ts";

export interface VisionGateConfig {
  /** Initial enabled state. Default `false` (opt-in). */
  enabled?: boolean;
  auditDispatcher?: AuditDispatcher;
  actorId?: string;
}

/**
 * Wraps an underlying `VisionAnalysisProvider` and refuses analyze calls
 * until `setEnabled(true)` has been invoked (typically via a user
 * consent UI).
 */
export class GatedVisionProvider implements VisionAnalysisProvider {
  readonly name: string;
  private enabled: boolean;
  private readonly auditDispatcher?: AuditDispatcher;
  private readonly actorId?: string;

  constructor(
    private readonly inner: VisionAnalysisProvider,
    config: VisionGateConfig = {},
  ) {
    this.name = `gated:${inner.name}`;
    this.enabled = config.enabled === true;
    this.auditDispatcher = config.auditDispatcher;
    this.actorId = config.actorId;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    if (!this.enabled) {
      if (this.auditDispatcher) {
        try {
          await this.auditDispatcher.emit({
            actor: {
              type: this.actorId ? "user" : "system",
              id: this.actorId ?? "agent",
            },
            action: "vision.denied",
            result: "denied",
            resource: { type: "vision", id: this.inner.name },
            metadata: {
              provider: this.inner.name,
              reason: "vision_disabled",
            },
          });
        } catch {
          // never block on audit
        }
      }
      const err = new Error(
        "Vision capability is disabled. Enable `vision.enabled` after user consent.",
      );
      (err as Error & { code?: string }).code = "VISION_DISABLED";
      throw err;
    }
    if (this.auditDispatcher) {
      try {
        await this.auditDispatcher.emit({
          actor: {
            type: this.actorId ? "user" : "system",
            id: this.actorId ?? "agent",
          },
          action: "vision.allowed",
          result: "success",
          resource: { type: "vision", id: this.inner.name },
          metadata: { provider: this.inner.name },
        });
      } catch {
        // never block on audit
      }
    }
    return this.inner.analyze(options);
  }
}

/**
 * Read the vision-enabled preference from runtime config / env. Defaults
 * to `false`.
 */
export function isVisionEnabledByDefault(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ELIZA_VISION_ENABLED === "1";
}
