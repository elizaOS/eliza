/**
 * Figma REST adapter for the design domain, running in local BYO-credential
 * mode with a personal access token (`X-Figma-Token`). Search lists the files
 * of one configured project (the Figma REST API has no search endpoint, so the
 * query filters that listing client-side and pagination is designed-absent).
 * Exports resolve node renders through `/v1/images` and return the short-lived
 * Figma URLs without rehosting bytes. Managed Cloud OAuth is a separate,
 * eligibility-gated path owned by the design service.
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
  designCommentPageSchema,
  designExportArtifactSchema,
  designExportRequestSchema,
  designPageSchema,
  designRefSchema,
  designSearchRequestSchema,
} from "./types.js";

export const FIGMA_PROVIDER_ID = "figma";
export const FIGMA_API_ORIGIN = "https://api.figma.com";

const wireText = z.string().min(1).max(2_048);

const figmaProjectFilesSchema = z.object({
  files: z
    .array(
      z.object({
        key: wireText,
        name: z.string().min(1).max(300),
        thumbnail_url: z.string().max(2_048).optional(),
        last_modified: wireText,
      }),
    )
    .max(1_000),
});

const figmaFileSchema = z.object({
  name: z.string().min(1).max(300),
  lastModified: wireText,
  thumbnailUrl: z.string().max(2_048).optional(),
  version: wireText.optional(),
});

const figmaImagesSchema = z.object({
  err: z.string().max(2_048).nullable(),
  images: z.record(z.string(), z.string().max(2_048).nullable()),
});

const figmaCommentsSchema = z.object({
  comments: z
    .array(
      z.object({
        id: wireText,
        message: z.string().max(10_000),
        user: z.object({ handle: z.string().min(1).max(300) }),
        created_at: wireText,
        resolved_at: wireText.nullable().optional(),
      }),
    )
    .max(1_000),
});

export interface FigmaDesignAdapterOptions {
  connectionId: string;
  personalAccessToken: string;
  /** Enables search by scoping the listing to one Figma project. */
  projectId?: string;
  /** Override for tests or a local desktop-bridge endpoint; defaults to the public API. */
  baseUrl?: string;
  timeoutMs?: number;
  responseByteLimit?: number;
  testTransport?: DesignTestTransport;
  allowPrivateNetworkForTests?: boolean;
}

function classifyFigmaError(
  status: number,
  body: unknown,
  retryAfterMs: number | undefined,
): DesignError {
  const err =
    body && typeof body === "object" && "err" in body
      ? String((body as { err?: unknown }).err ?? "").toLowerCase()
      : "";
  if (status === 429) {
    return new DesignError("Figma is rate limited.", {
      code: "DESIGN_RATE_LIMITED",
      retryAfterMs,
      context: { status },
    });
  }
  if (status === 401 || status === 403) {
    if (err.includes("expired")) {
      return new DesignError("The Figma token has expired.", {
        code: "DESIGN_AUTH_EXPIRED",
        context: { status },
      });
    }
    if (err.includes("plan") || err.includes("seat")) {
      return new DesignError(
        "This Figma operation is limited by the account's plan or seat.",
        { code: "DESIGN_PLAN_LIMITED", context: { status } },
      );
    }
    return new DesignError("The Figma token was revoked or is invalid.", {
      code: "DESIGN_AUTH_REVOKED",
      context: { status },
    });
  }
  if (status >= 500) {
    return new DesignError("Figma failed.", {
      code: "DESIGN_PROVIDER_FAILURE",
      context: { status },
    });
  }
  return new DesignError("Figma rejected the request.", {
    code: "DESIGN_PROVIDER_REJECTED",
    context: { status },
  });
}

function figmaDeepLink(fileKey: string): string {
  return `https://www.figma.com/design/${encodeURIComponent(fileKey)}`;
}

function isoOrUndefined(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function httpsOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    // error-policy:J3 A malformed provider thumbnail URL becomes an explicit
    // absent optional field, never a fake-valid value.
    return undefined;
  }
}

export class FigmaDesignAdapter implements DesignProviderAdapter {
  readonly id = FIGMA_PROVIDER_ID;
  readonly capabilities: ReadonlySet<DesignCapability>;
  private readonly core: DesignHttpCore;
  private readonly projectId?: string;

  constructor(options: FigmaDesignAdapterOptions) {
    if (!options.personalAccessToken.trim()) {
      throw new DesignError("Figma requires a personal access token.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    if (
      options.projectId !== undefined &&
      !/^\d{1,64}$/.test(options.projectId)
    ) {
      throw new DesignError("Figma project id must be numeric.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    this.projectId = options.projectId;
    this.capabilities = new Set<DesignCapability>([
      ...(this.projectId ? (["search"] as const) : []),
      "get",
      "export",
      "comments",
    ]);
    this.core = new DesignHttpCore({
      providerId: FIGMA_PROVIDER_ID,
      connectionId: options.connectionId,
      baseUrl: options.baseUrl ?? FIGMA_API_ORIGIN,
      credentialHeader: {
        name: "x-figma-token",
        value: options.personalAccessToken,
      },
      timeoutMs: options.timeoutMs,
      responseByteLimit: options.responseByteLimit,
      testTransport: options.testTransport,
      allowPrivateNetworkForTests: options.allowPrivateNetworkForTests,
      classifyError: classifyFigmaError,
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
    if (!this.projectId) {
      throw new DesignError(
        "Figma search requires FIGMA_PROJECT_ID because the REST API has no search endpoint.",
        { code: "DESIGN_UNSUPPORTED" },
      );
    }
    if (parsed.data.cursor !== undefined) {
      throw new DesignError(
        "Figma project listings are not paginated; a cursor is invalid here.",
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    const url = new URL(
      `/v1/projects/${encodeURIComponent(this.projectId)}/files`,
      this.core.baseOrigin,
    );
    const listing = await this.core.requestJson(
      url,
      { method: "GET" },
      figmaProjectFilesSchema,
    );
    if (listing === null) {
      throw new DesignError("Figma project listing was unexpectedly absent.", {
        code: "DESIGN_MALFORMED_RESPONSE",
      });
    }
    const query = parsed.data.query.toLowerCase();
    const limit = parsed.data.limit ?? 100;
    const designs = listing.files
      .filter((file) => file.name.toLowerCase().includes(query))
      .slice(0, limit)
      .map((file) =>
        this.normalizedRef({
          providerDesignId: file.key,
          name: file.name,
          thumbnailUrl: httpsOrUndefined(file.thumbnail_url),
          updatedAt: isoOrUndefined(file.last_modified),
        }),
      );
    return designPageSchema.parse({ designs, nextCursor: null });
  }

  async getDesign(providerDesignId: string): Promise<DesignRef | null> {
    this.assertDesignId(providerDesignId);
    const url = new URL(
      `/v1/files/${encodeURIComponent(providerDesignId)}`,
      this.core.baseOrigin,
    );
    url.searchParams.set("depth", "1");
    const file = await this.core.requestJson(
      url,
      { method: "GET" },
      figmaFileSchema,
      { allowNotFound: true },
    );
    if (file === null) return null;
    return this.normalizedRef({
      providerDesignId,
      name: file.name,
      thumbnailUrl: httpsOrUndefined(file.thumbnailUrl),
      updatedAt: isoOrUndefined(file.lastModified),
    });
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
    if (!parsed.data.nodeId) {
      throw new DesignError(
        "Figma exports render specific nodes; a nodeId is required.",
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    const url = new URL(
      `/v1/images/${encodeURIComponent(parsed.data.providerDesignId)}`,
      this.core.baseOrigin,
    );
    url.searchParams.set("ids", parsed.data.nodeId);
    url.searchParams.set("format", parsed.data.format);
    if (parsed.data.scale !== undefined)
      url.searchParams.set("scale", String(parsed.data.scale));
    const rendered = await this.core.requestJson(
      url,
      { method: "GET" },
      figmaImagesSchema,
    );
    if (rendered === null || rendered.err !== null) {
      throw new DesignError("Figma could not render the requested export.", {
        code: "DESIGN_EXPORT_FAILED",
        context: { providerError: rendered?.err ?? "absent response" },
      });
    }
    const urls = Object.values(rendered.images).filter(
      (value): value is string => typeof value === "string",
    );
    if (
      urls.length === 0 ||
      urls.length !== Object.keys(rendered.images).length
    ) {
      throw new DesignError(
        "Figma reported one or more nodes it could not render.",
        { code: "DESIGN_EXPORT_FAILED" },
      );
    }
    const artifact = designExportArtifactSchema.safeParse({
      provider: this.id,
      providerDesignId: parsed.data.providerDesignId,
      format: parsed.data.format,
      urls,
    });
    if (!artifact.success) {
      throw new DesignError("Figma returned invalid export URLs.", {
        code: "DESIGN_MALFORMED_RESPONSE",
        cause: artifact.error,
      });
    }
    return artifact.data;
  }

  async listComments(
    providerDesignId: string,
    cursor?: string,
  ): Promise<DesignCommentPage> {
    this.assertDesignId(providerDesignId);
    if (cursor !== undefined) {
      throw new DesignError(
        "Figma comment listings are not paginated; a cursor is invalid here.",
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    const url = new URL(
      `/v1/files/${encodeURIComponent(providerDesignId)}/comments`,
      this.core.baseOrigin,
    );
    const listing = await this.core.requestJson(
      url,
      { method: "GET" },
      figmaCommentsSchema,
    );
    if (listing === null) {
      throw new DesignError("Figma comment listing was unexpectedly absent.", {
        code: "DESIGN_MALFORMED_RESPONSE",
      });
    }
    const comments = listing.comments.slice(0, 200).map((comment) => {
      const createdAt = isoOrUndefined(comment.created_at);
      if (!createdAt) {
        throw new DesignError("Figma returned an invalid comment timestamp.", {
          code: "DESIGN_MALFORMED_RESPONSE",
        });
      }
      return {
        provider: this.id,
        commentId: comment.id,
        message: comment.message,
        author: comment.user.handle,
        createdAt,
        resolved: typeof comment.resolved_at === "string",
      };
    });
    return designCommentPageSchema.parse({ comments, nextCursor: null });
  }

  private assertDesignId(providerDesignId: string): void {
    if (!providerDesignId || providerDesignId.length > 512) {
      throw new DesignError("Design id is invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
  }

  private normalizedRef(fields: {
    providerDesignId: string;
    name: string;
    thumbnailUrl?: string;
    updatedAt?: string;
  }): DesignRef {
    const parsed = designRefSchema.safeParse({
      provider: this.id,
      providerDesignId: fields.providerDesignId,
      name: fields.name,
      deepLinkUrl: figmaDeepLink(fields.providerDesignId),
      ...(fields.thumbnailUrl ? { thumbnailUrl: fields.thumbnailUrl } : {}),
      ...(fields.updatedAt ? { updatedAt: fields.updatedAt } : {}),
    });
    if (!parsed.success) {
      throw new DesignError("Figma returned an invalid design record.", {
        code: "DESIGN_MALFORMED_RESPONSE",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
