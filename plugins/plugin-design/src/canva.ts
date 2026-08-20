/**
 * Canva Connect adapter for the design domain, running in local BYO-credential
 * mode with a user-supplied Connect access token. Search maps the paginated
 * `/rest/v1/designs` listing with opaque continuation cursors; exports create
 * an asynchronous export job and poll it under a bounded attempt budget,
 * returning short-lived Canva download URLs without rehosting bytes. Comment
 * reads and SVG export are designed-unsupported until Canva grants the
 * corresponding beta/paid capability to the connected integration, and the
 * limitation surfaces as a typed error instead of a fabricated empty result.
 */

import * as z from "zod";
import type { DesignProviderAdapter } from "./adapter.js";
import { DesignError } from "./errors.js";
import { DesignHttpCore, type DesignTestTransport } from "./http.js";
import {
  type DesignCapability,
  type DesignCommentPage,
  type DesignExportArtifact,
  type DesignExportRequest,
  type DesignPage,
  type DesignRef,
  type DesignSearchRequest,
  designExportArtifactSchema,
  designExportRequestSchema,
  designPageSchema,
  designRefSchema,
  designSearchRequestSchema,
} from "./types.js";

export const CANVA_PROVIDER_ID = "canva";
export const CANVA_API_ORIGIN = "https://api.canva.com";

const wireText = z.string().min(1).max(2_048);

const canvaDesignItemSchema = z.object({
  id: wireText,
  title: z.string().max(300).optional(),
  thumbnail: z.object({ url: z.string().max(2_048) }).optional(),
  urls: z.object({
    view_url: z.string().max(2_048),
    edit_url: z.string().max(2_048).optional(),
  }),
  updated_at: z.number().int().nonnegative().optional(),
});

const canvaDesignListSchema = z.object({
  items: z.array(canvaDesignItemSchema).max(100),
  continuation: wireText.optional(),
});

const canvaDesignGetSchema = z.object({ design: canvaDesignItemSchema });

const canvaExportJobSchema = z.object({
  job: z.object({
    id: wireText,
    status: z.enum(["in_progress", "success", "failed"]),
    urls: z.array(z.string().max(2_048)).max(20).optional(),
    error: z
      .object({ code: wireText, message: z.string().max(2_048) })
      .optional(),
  }),
});

const PLAN_LIMITED_CODES = new Set([
  "license_required",
  "premium_feature",
  "plan_limited",
  "feature_not_available",
]);
const REVOKED_CODES = new Set(["revoked_token", "banned_user"]);

export interface CanvaDesignAdapterOptions {
  connectionId: string;
  accessToken: string;
  /** Override for tests only; defaults to the public Connect API. */
  baseUrl?: string;
  timeoutMs?: number;
  responseByteLimit?: number;
  /** Export-job polling bounds; tests inject a zero-delay sleep. */
  maxPollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  testTransport?: DesignTestTransport;
  allowPrivateNetworkForTests?: boolean;
}

function classifyCanvaError(
  status: number,
  body: unknown,
  retryAfterMs: number | undefined,
): DesignError {
  const code =
    body && typeof body === "object" && "code" in body
      ? String((body as { code?: unknown }).code)
      : "";
  if (status === 429) {
    return new DesignError("Canva is rate limited.", {
      code: "DESIGN_RATE_LIMITED",
      retryAfterMs,
      context: { status },
    });
  }
  if (PLAN_LIMITED_CODES.has(code)) {
    return new DesignError(
      "This Canva operation requires a paid or beta capability the connected account lacks.",
      { code: "DESIGN_PLAN_LIMITED", context: { status, providerCode: code } },
    );
  }
  if (status === 401) {
    return new DesignError("The Canva access token has expired.", {
      code: "DESIGN_AUTH_EXPIRED",
      context: { status },
    });
  }
  if (status === 403 && REVOKED_CODES.has(code)) {
    return new DesignError("The Canva connection was revoked.", {
      code: "DESIGN_AUTH_REVOKED",
      context: { status },
    });
  }
  if (status >= 500) {
    return new DesignError("Canva failed.", {
      code: "DESIGN_PROVIDER_FAILURE",
      context: { status },
    });
  }
  return new DesignError("Canva rejected the request.", {
    code: "DESIGN_PROVIDER_REJECTED",
    context: { status, ...(code ? { providerCode: code } : {}) },
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class CanvaDesignAdapter implements DesignProviderAdapter {
  readonly id = CANVA_PROVIDER_ID;
  readonly capabilities: ReadonlySet<DesignCapability> = new Set([
    "search",
    "get",
    "export",
  ]);
  private readonly core: DesignHttpCore;
  private readonly maxPollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CanvaDesignAdapterOptions) {
    if (!options.accessToken.trim()) {
      throw new DesignError("Canva requires a Connect access token.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    const maxPollAttempts = options.maxPollAttempts ?? 20;
    const pollDelayMs = options.pollDelayMs ?? 500;
    if (
      !Number.isInteger(maxPollAttempts) ||
      maxPollAttempts < 1 ||
      maxPollAttempts > 120 ||
      !Number.isInteger(pollDelayMs) ||
      pollDelayMs < 0 ||
      pollDelayMs > 10_000
    ) {
      throw new DesignError("Canva export polling bounds are invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    this.maxPollAttempts = maxPollAttempts;
    this.pollDelayMs = pollDelayMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.core = new DesignHttpCore({
      providerId: CANVA_PROVIDER_ID,
      connectionId: options.connectionId,
      baseUrl: options.baseUrl ?? CANVA_API_ORIGIN,
      credentialHeader: {
        name: "authorization",
        value: `Bearer ${options.accessToken}`,
      },
      timeoutMs: options.timeoutMs,
      responseByteLimit: options.responseByteLimit,
      testTransport: options.testTransport,
      allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
      classifyError: classifyCanvaError,
    });
  }

  get connectionId(): string {
    return this.core.connectionId;
  }

  async searchDesigns(request: DesignSearchRequest): Promise<DesignPage> {
    const parsed = designSearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new DesignError("Design search request is invalid.", {
        code: "DESIGN_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const url = new URL("/rest/v1/designs", this.core.baseOrigin);
    url.searchParams.set("query", parsed.data.query);
    if (parsed.data.cursor)
      url.searchParams.set("continuation", parsed.data.cursor);
    if (parsed.data.limit !== undefined)
      url.searchParams.set("limit", String(parsed.data.limit));
    const listing = await this.core.requestJson(
      url,
      { method: "GET" },
      canvaDesignListSchema,
    );
    if (listing === null) {
      throw new DesignError("Canva design listing was unexpectedly absent.", {
        code: "DESIGN_MALFORMED_RESPONSE",
      });
    }
    return designPageSchema.parse({
      designs: listing.items.map((item) => this.normalizedRef(item)),
      nextCursor: listing.continuation ?? null,
    });
  }

  async getDesign(providerDesignId: string): Promise<DesignRef | null> {
    if (!providerDesignId || providerDesignId.length > 512) {
      throw new DesignError("Design id is invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    const url = new URL(
      `/rest/v1/designs/${encodeURIComponent(providerDesignId)}`,
      this.core.baseOrigin,
    );
    const detail = await this.core.requestJson(
      url,
      { method: "GET" },
      canvaDesignGetSchema,
      { allowNotFound: true },
    );
    return detail === null ? null : this.normalizedRef(detail.design);
  }

  async exportDesign(
    request: DesignExportRequest,
  ): Promise<DesignExportArtifact> {
    const parsed = designExportRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new DesignError("Design export request is invalid.", {
        code: "DESIGN_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    if (parsed.data.format === "svg") {
      throw new DesignError("Canva does not export SVG.", {
        code: "DESIGN_UNSUPPORTED",
      });
    }
    const createUrl = new URL("/rest/v1/exports", this.core.baseOrigin);
    const created = await this.core.requestJson(
      createUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          design_id: parsed.data.providerDesignId,
          format: { type: parsed.data.format },
        }),
      },
      canvaExportJobSchema,
    );
    if (created === null) {
      throw new DesignError("Canva export job was unexpectedly absent.", {
        code: "DESIGN_MALFORMED_RESPONSE",
      });
    }
    let job = created.job;
    for (
      let attempt = 0;
      job.status === "in_progress" && attempt < this.maxPollAttempts;
      attempt += 1
    ) {
      if (this.pollDelayMs > 0) await this.sleep(this.pollDelayMs);
      const pollUrl = new URL(
        `/rest/v1/exports/${encodeURIComponent(job.id)}`,
        this.core.baseOrigin,
      );
      const polled = await this.core.requestJson(
        pollUrl,
        { method: "GET" },
        canvaExportJobSchema,
      );
      if (polled === null) {
        throw new DesignError("Canva export job was unexpectedly absent.", {
          code: "DESIGN_MALFORMED_RESPONSE",
        });
      }
      job = polled.job;
    }
    if (job.status === "in_progress") {
      throw new DesignError(
        "The Canva export did not complete within the polling budget.",
        {
          code: "DESIGN_PROVIDER_TIMEOUT",
          context: { jobId: job.id, attempts: this.maxPollAttempts },
        },
      );
    }
    if (job.status === "failed") {
      if (job.error && PLAN_LIMITED_CODES.has(job.error.code)) {
        throw new DesignError(
          "This Canva export requires a paid or beta capability the connected account lacks.",
          {
            code: "DESIGN_PLAN_LIMITED",
            context: { jobId: job.id, providerCode: job.error.code },
          },
        );
      }
      throw new DesignError("Canva could not export the design.", {
        code: "DESIGN_EXPORT_FAILED",
        context: {
          jobId: job.id,
          ...(job.error ? { providerCode: job.error.code } : {}),
        },
      });
    }
    const artifact = designExportArtifactSchema.safeParse({
      provider: this.id,
      providerDesignId: parsed.data.providerDesignId,
      format: parsed.data.format,
      urls: job.urls ?? [],
    });
    if (!artifact.success) {
      throw new DesignError(
        "Canva reported a successful export without valid download URLs.",
        { code: "DESIGN_MALFORMED_RESPONSE", cause: artifact.error },
      );
    }
    return artifact.data;
  }

  async listComments(): Promise<DesignCommentPage> {
    throw new DesignError(
      "Canva comment reads require the Comment API beta capability, which is not granted to BYO Connect integrations.",
      { code: "DESIGN_UNSUPPORTED" },
    );
  }

  private normalizedRef(
    item: z.infer<typeof canvaDesignItemSchema>,
  ): DesignRef {
    const parsed = designRefSchema.safeParse({
      provider: this.id,
      providerDesignId: item.id,
      // Canva permits untitled designs; mirror the provider's own placeholder.
      name: item.title?.trim() ? item.title : "Untitled design",
      deepLinkUrl: item.urls.view_url,
      ...(item.thumbnail ? { thumbnailUrl: item.thumbnail.url } : {}),
      ...(item.updated_at !== undefined
        ? { updatedAt: new Date(item.updated_at * 1_000).toISOString() }
        : {}),
    });
    if (!parsed.success) {
      throw new DesignError("Canva returned an invalid design record.", {
        code: "DESIGN_MALFORMED_RESPONSE",
        cause: parsed.error,
      });
    }
    for (const link of [parsed.data.deepLinkUrl, parsed.data.thumbnailUrl]) {
      if (link && !/(^|\.)canva\.com$/.test(new URL(link).hostname)) {
        throw new DesignError(
          "Canva returned a deep link outside the canva.com domain.",
          { code: "DESIGN_MALFORMED_RESPONSE", context: { link } },
        );
      }
    }
    return parsed.data;
  }
}
