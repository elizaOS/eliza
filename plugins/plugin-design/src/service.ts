/**
 * Owns normalized design operations, provider adapter selection, and the
 * local-versus-managed connection policy. Local mode builds adapters only
 * from explicit user-supplied credentials in runtime settings and never
 * silently falls back to Cloud; managed Cloud OAuth for Canva and Figma is
 * eligibility-gated and stays a typed ineligible state until the provider
 * apps are approved and the managed adapter SDK path is wired.
 */

import { randomBytes } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import type { DesignProviderAdapter } from "./adapter.js";
import { CanvaDesignAdapter } from "./canva.js";
import { DesignError } from "./errors.js";
import { FigmaDesignAdapter } from "./figma.js";
import {
  type DesignCommentPage,
  type DesignExportArtifact,
  type DesignExportRequest,
  type DesignPage,
  type DesignRef,
  type DesignSearchRequest,
  designCommentPageSchema,
  designExportArtifactSchema,
  designPageSchema,
  designRefSchema,
} from "./types.js";

export const DESIGN_SERVICE_TYPE = "design";

export type ManagedDesignProvider = "canva" | "figma";

export interface ManagedDesignEligibility {
  eligible: false;
  reason: string;
}

/**
 * Managed Cloud OAuth is blocked on human-only provider app registration and
 * review. Flipping a provider to eligible is a deliberate code change made
 * with the approved app credentials custody in Cloud, never a runtime toggle.
 */
export const MANAGED_DESIGN_ELIGIBILITY: Readonly<
  Record<ManagedDesignProvider, ManagedDesignEligibility>
> = {
  canva: {
    eligible: false,
    reason:
      "Canva Connect integration review has not been granted; use local mode with CANVA_ACCESS_TOKEN.",
  },
  figma: {
    eligible: false,
    reason:
      "Figma OAuth app approval has not been granted; use local mode with FIGMA_PERSONAL_ACCESS_TOKEN.",
  },
};

function localConnectionId(provider: string): string {
  return `conn_local_${provider}_${randomBytes(12).toString("base64url")}`;
}

function validated<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DesignError(message, {
      code: "DESIGN_INVALID_INPUT",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertProviderBinding<T extends { provider: string }>(
  record: T,
  adapter: DesignProviderAdapter,
  surface: string,
): T {
  if (record.provider !== adapter.id) {
    throw new DesignError(
      "Design provider response spoofed another provider.",
      {
        code: "DESIGN_MALFORMED_RESPONSE",
        context: {
          adapterId: adapter.id,
          responseProvider: record.provider,
          surface,
        },
      },
    );
  }
  return record;
}

export class DesignService extends Service {
  static override readonly serviceType = DESIGN_SERVICE_TYPE;
  override capabilityDescription =
    "Provider-neutral design search, lookup, node/design export, and comment reads over Canva and Figma adapters.";

  private readonly adapters = new Map<string, DesignProviderAdapter>();
  private defaultAdapterId: string | null = null;

  static override async start(runtime: IAgentRuntime): Promise<DesignService> {
    const service = new DesignService(runtime);
    const figmaToken = runtime.getSetting("FIGMA_PERSONAL_ACCESS_TOKEN");
    if (typeof figmaToken === "string" && figmaToken.trim()) {
      const projectId = runtime.getSetting("FIGMA_PROJECT_ID");
      const baseUrl = runtime.getSetting("FIGMA_API_BASE_URL");
      service.registerAdapter(
        new FigmaDesignAdapter({
          connectionId: localConnectionId("figma"),
          personalAccessToken: figmaToken,
          ...(typeof projectId === "string" && projectId.trim()
            ? { projectId: projectId.trim() }
            : {}),
          ...(typeof baseUrl === "string" && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
        }),
      );
      logger.info(
        "[DesignService] Registered local-mode Figma adapter from runtime settings",
      );
    }
    const canvaToken = runtime.getSetting("CANVA_ACCESS_TOKEN");
    if (typeof canvaToken === "string" && canvaToken.trim()) {
      const baseUrl = runtime.getSetting("CANVA_API_BASE_URL");
      service.registerAdapter(
        new CanvaDesignAdapter({
          connectionId: localConnectionId("canva"),
          accessToken: canvaToken,
          ...(typeof baseUrl === "string" && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
        }),
      );
      logger.info(
        "[DesignService] Registered local-mode Canva adapter from runtime settings",
      );
    }
    return service;
  }

  override async stop(): Promise<void> {
    this.adapters.clear();
    this.defaultAdapterId = null;
  }

  registerAdapter(adapter: DesignProviderAdapter, makeDefault = false): void {
    if (
      !/^[a-z0-9][a-z0-9_-]*$/i.test(adapter.id) ||
      !/^conn_[A-Za-z0-9_-]{16,}$/.test(adapter.connectionId)
    ) {
      throw new DesignError("Design adapter identity is invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    this.adapters.set(adapter.id, adapter);
    if (makeDefault || this.defaultAdapterId === null)
      this.defaultAdapterId = adapter.id;
  }

  unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId);
    if (this.defaultAdapterId === adapterId) {
      this.defaultAdapterId = this.adapters.keys().next().value ?? null;
    }
  }

  listAdapters(): readonly string[] {
    return [...this.adapters.keys()];
  }

  /** Managed Cloud OAuth is not yet eligible for any design provider. */
  managedEligibility(
    provider: ManagedDesignProvider,
  ): ManagedDesignEligibility {
    return MANAGED_DESIGN_ELIGIBILITY[provider];
  }

  connectManaged(provider: ManagedDesignProvider): never {
    throw new DesignError(
      `Managed ${provider} connections are not yet eligible: ${MANAGED_DESIGN_ELIGIBILITY[provider].reason}`,
      {
        code: "DESIGN_MANAGED_MODE_INELIGIBLE",
        context: { provider },
      },
    );
  }

  async searchDesigns(
    request: DesignSearchRequest,
    provider?: string,
  ): Promise<DesignPage> {
    const adapter = this.adapter(provider, "search");
    const page = validated(
      designPageSchema,
      await adapter.searchDesigns(request),
      "Design provider returned an invalid design page.",
    );
    return {
      ...page,
      designs: page.designs.map((design) =>
        assertProviderBinding(design, adapter, "design search result"),
      ),
    };
  }

  async getDesign(
    providerDesignId: string,
    provider?: string,
  ): Promise<DesignRef | null> {
    const adapter = this.adapter(provider, "get");
    const design = await adapter.getDesign(providerDesignId);
    if (design === null) return null;
    return assertProviderBinding(
      validated(
        designRefSchema,
        design,
        "Design provider returned an invalid design record.",
      ),
      adapter,
      "design detail",
    );
  }

  async exportDesign(
    request: DesignExportRequest,
    provider?: string,
  ): Promise<DesignExportArtifact> {
    const adapter = this.adapter(provider, "export");
    return assertProviderBinding(
      validated(
        designExportArtifactSchema,
        await adapter.exportDesign(request),
        "Design provider returned an invalid export artifact.",
      ),
      adapter,
      "design export",
    );
  }

  async listComments(
    providerDesignId: string,
    provider?: string,
    cursor?: string,
  ): Promise<DesignCommentPage> {
    const adapter = this.adapter(provider, "comments");
    const page = validated(
      designCommentPageSchema,
      await adapter.listComments(providerDesignId, cursor),
      "Design provider returned an invalid comment page.",
    );
    return {
      ...page,
      comments: page.comments.map((comment) =>
        assertProviderBinding(comment, adapter, "design comment"),
      ),
    };
  }

  private adapter(
    provider: string | undefined,
    capability: "search" | "get" | "export" | "comments",
  ): DesignProviderAdapter {
    const id = provider ?? this.defaultAdapterId;
    if (!id) {
      throw new DesignError(
        "No design provider is connected. Local mode requires FIGMA_PERSONAL_ACCESS_TOKEN or CANVA_ACCESS_TOKEN; managed Cloud connections are not yet eligible.",
        { code: "DESIGN_NOT_CONNECTED" },
      );
    }
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new DesignError(`Design provider "${id}" is not connected.`, {
        code: "DESIGN_NOT_CONNECTED",
        context: { provider: id, connected: [...this.adapters.keys()] },
      });
    }
    if (!adapter.capabilities.has(capability)) {
      throw new DesignError(
        `Design provider "${adapter.id}" does not support ${capability}.`,
        {
          code: "DESIGN_UNSUPPORTED",
          context: { provider: adapter.id, capability },
        },
      );
    }
    return adapter;
  }
}
