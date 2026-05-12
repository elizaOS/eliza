import { ApiError } from "@/lib/api/cloud-worker-errors";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { logger } from "@/lib/utils/logger";

const OPENAI_MODERATIONS_URL = "https://api.openai.com/v1/moderations";
const DEFAULT_MODERATION_MODEL = "omni-moderation-latest";
const MAX_TEXT_CHARS = 24_000;
const MAX_IMAGE_INPUTS = 8;

export const OPENAI_MODERATION_CATEGORIES = [
  "sexual",
  "sexual/minors",
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence",
  "violence/graphic",
] as const;

export type OpenAIModerationCategory = (typeof OPENAI_MODERATION_CATEGORIES)[number];

export type ContentSafetySurface =
  | "media_generation_prompt"
  | "media_generation_output"
  | "promotion_asset_prompt"
  | "promotion_asset_output"
  | "promotion_copy"
  | "advertising_campaign"
  | "advertising_creative";

export interface ContentSafetyInput {
  surface: ContentSafetySurface;
  organizationId?: string;
  userId?: string;
  appId?: string;
  campaignId?: string;
  creativeId?: string;
  text?: string | Array<string | undefined | null>;
  imageUrls?: string[];
  allowDataImages?: boolean;
  requireConfigured?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ContentSafetyReview {
  allowed: boolean;
  blocked: boolean;
  skipped: boolean;
  mode: "enforce" | "warn" | "off";
  surface: ContentSafetySurface;
  provider: "openai";
  model?: string;
  moderationId?: string;
  flagged: boolean;
  flaggedCategories: OpenAIModerationCategory[];
  categoryScores: Partial<Record<OpenAIModerationCategory, number>>;
  categoryAppliedInputTypes?: Partial<Record<OpenAIModerationCategory, string[]>>;
  issues: string[];
}

interface OpenAIModerationResult {
  flagged?: boolean;
  categories?: Partial<Record<OpenAIModerationCategory, boolean>>;
  category_scores?: Partial<Record<OpenAIModerationCategory, number>>;
  category_applied_input_types?: Partial<Record<OpenAIModerationCategory, string[]>>;
}

interface OpenAIModerationResponse {
  id?: string;
  model?: string;
  results?: OpenAIModerationResult[];
}

type ModerationRequestInput =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

const HARD_BLOCK_THRESHOLDS: Partial<Record<OpenAIModerationCategory, number>> = {
  "sexual/minors": 0.2,
};

let loggedMissingKey = false;
let loggedDisabled = false;

function compactText(input: ContentSafetyInput["text"]): string {
  const values = Array.isArray(input) ? input : [input];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_TEXT_CHARS);
}

function categoryRecord<T>(
  value: Partial<Record<OpenAIModerationCategory, T>> | undefined,
): Partial<Record<OpenAIModerationCategory, T>> {
  if (!value) return {};
  const out: Partial<Record<OpenAIModerationCategory, T>> = {};
  for (const category of OPENAI_MODERATION_CATEGORIES) {
    if (value[category] !== undefined) {
      out[category] = value[category];
    }
  }
  return out;
}

function configuredMode(env: NodeJS.ProcessEnv): "enforce" | "warn" | "off" {
  const mode = env.CONTENT_SAFETY_MODE?.trim().toLowerCase();
  if (mode === "off" || mode === "warn") return mode;
  return "enforce";
}

function requireConfigured(env: NodeJS.ProcessEnv, input: ContentSafetyInput): boolean {
  return input.requireConfigured ?? env.CONTENT_SAFETY_REQUIRE_CONFIG === "true";
}

async function normalizeImageUrls(input: ContentSafetyInput): Promise<{
  urls: string[];
  issues: string[];
}> {
  const urls: string[] = [];
  const issues: string[] = [];
  const rawUrls = (input.imageUrls ?? []).filter(Boolean).slice(0, MAX_IMAGE_INPUTS);

  for (const rawUrl of rawUrls) {
    if (rawUrl.startsWith("data:image/")) {
      if (input.allowDataImages) {
        urls.push(rawUrl);
      } else {
        issues.push("data_image_not_allowed");
      }
      continue;
    }

    try {
      const safeUrl = await assertSafeOutboundUrl(rawUrl);
      urls.push(safeUrl.toString());
    } catch (error) {
      issues.push("unsafe_image_url");
      logger.warn("[ContentSafety] Rejected unsafe image URL before moderation", {
        surface: input.surface,
        organizationId: input.organizationId,
        appId: input.appId,
        campaignId: input.campaignId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if ((input.imageUrls?.length ?? 0) > MAX_IMAGE_INPUTS) {
    issues.push("too_many_images_truncated");
  }

  return { urls, issues };
}

function buildModerationInput(text: string, imageUrls: string[]): ModerationRequestInput | null {
  if (!text && imageUrls.length === 0) return null;
  if (text && imageUrls.length === 0) return text;

  const parts: Exclude<ModerationRequestInput, string> = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const url of imageUrls) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

function emptyReview(
  input: ContentSafetyInput,
  mode: "enforce" | "warn" | "off",
): ContentSafetyReview {
  return {
    allowed: true,
    blocked: false,
    skipped: true,
    mode,
    surface: input.surface,
    provider: "openai",
    flagged: false,
    flaggedCategories: [],
    categoryScores: {},
    issues: [],
  };
}

function toBlockedReview(
  input: ContentSafetyInput,
  mode: "enforce" | "warn" | "off",
  issues: string[],
): ContentSafetyReview {
  return {
    allowed: mode !== "enforce",
    blocked: mode === "enforce",
    skipped: false,
    mode,
    surface: input.surface,
    provider: "openai",
    flagged: true,
    flaggedCategories: [],
    categoryScores: {},
    issues,
  };
}

function buildBlockedError(review: ContentSafetyReview): ApiError {
  return new ApiError(400, "validation_error", "Content failed safety review", {
    surface: review.surface,
    provider: review.provider,
    model: review.model,
    flagged: review.flagged,
    flaggedCategories: review.flaggedCategories,
    categoryScores: review.categoryScores,
    issues: review.issues,
  });
}

export class ContentSafetyService {
  async reviewPublicContent(input: ContentSafetyInput): Promise<ContentSafetyReview> {
    const env = getCloudAwareEnv();
    const mode = configuredMode(env);

    if (mode === "off") {
      if (!loggedDisabled) {
        loggedDisabled = true;
        logger.warn("[ContentSafety] Public content safety disabled via CONTENT_SAFETY_MODE=off");
      }
      return emptyReview(input, mode);
    }

    const text = compactText(input.text);
    const { urls: imageUrls, issues } = await normalizeImageUrls(input);
    if (issues.includes("unsafe_image_url") || issues.includes("data_image_not_allowed")) {
      return toBlockedReview(input, mode, issues);
    }

    const moderationInput = buildModerationInput(text, imageUrls);
    if (!moderationInput) {
      const review = emptyReview(input, mode);
      review.issues.push("no_content");
      return review;
    }

    const apiKey = env.OPENAI_MODERATION_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
    if (!apiKey) {
      if (requireConfigured(env, input)) {
        throw new ApiError(503, "internal_error", "Content safety moderation is not configured");
      }
      if (!loggedMissingKey) {
        loggedMissingKey = true;
        logger.warn(
          "[ContentSafety] OPENAI_MODERATION_API_KEY/OPENAI_API_KEY not configured; public content safety skipped",
        );
      }
      const review = emptyReview(input, mode);
      review.issues.push("moderation_not_configured");
      return review;
    }

    const model = env.OPENAI_MODERATION_MODEL?.trim() || DEFAULT_MODERATION_MODEL;
    const response = await fetch(OPENAI_MODERATIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: moderationInput,
      }),
    });

    if (!response.ok) {
      const issue = `moderation_unavailable_${response.status}`;
      if (env.CONTENT_SAFETY_FAIL_OPEN === "true") {
        logger.error("[ContentSafety] Moderation unavailable; allowing because fail-open is set", {
          surface: input.surface,
          status: response.status,
          statusText: response.statusText,
        });
        const review = emptyReview(input, mode);
        review.issues.push(issue);
        return review;
      }
      throw new ApiError(503, "internal_error", "Content safety moderation is unavailable", {
        status: response.status,
        statusText: response.statusText,
      });
    }

    const data = (await response.json()) as OpenAIModerationResponse;
    const result = data.results?.[0];
    if (!result) {
      throw new ApiError(503, "internal_error", "Content safety moderation returned no result");
    }

    const categories = categoryRecord(result.categories);
    const scores = categoryRecord(result.category_scores);
    const appliedInputTypes = categoryRecord(result.category_applied_input_types);
    const flaggedCategories = OPENAI_MODERATION_CATEGORIES.filter(
      (category) =>
        categories[category] === true ||
        (HARD_BLOCK_THRESHOLDS[category] !== undefined &&
          (scores[category] ?? 0) >= HARD_BLOCK_THRESHOLDS[category]),
    );
    const flagged = result.flagged === true || flaggedCategories.length > 0;
    const blocked = mode === "enforce" && flagged;

    if (flagged) {
      logger.warn("[ContentSafety] Public content flagged", {
        surface: input.surface,
        organizationId: input.organizationId,
        userId: input.userId,
        appId: input.appId,
        campaignId: input.campaignId,
        creativeId: input.creativeId,
        mode,
        blocked,
        flaggedCategories,
        metadata: input.metadata,
      });
    }

    return {
      allowed: !blocked,
      blocked,
      skipped: false,
      mode,
      surface: input.surface,
      provider: "openai",
      model: data.model ?? model,
      moderationId: data.id,
      flagged,
      flaggedCategories,
      categoryScores: scores,
      categoryAppliedInputTypes: appliedInputTypes,
      issues,
    };
  }

  async assertSafeForPublicUse(input: ContentSafetyInput): Promise<ContentSafetyReview> {
    const review = await this.reviewPublicContent(input);
    if (!review.allowed) {
      throw buildBlockedError(review);
    }
    return review;
  }
}

export const contentSafetyService = new ContentSafetyService();
