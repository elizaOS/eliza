/**
 * Automated app compliance-review gate (#10732).
 *
 * A miniapp must pass an automated, binary (allow/ban) compliance review before
 * it can enable monetization or take payments. The sole question the classifier
 * answers is *policy*, not morality: **would monetizing this app get us banned
 * by our payment providers (Stripe/OxaPay) or is it illegal under US law?**
 *
 * Two stages:
 *   1. A cheap, deterministic keyword pre-filter that bans obvious prohibited
 *      categories without spending an LLM call.
 *   2. An LLM classifier ({@link https://sdk.vercel.ai `generateObject`}) that
 *      scores the assembled listing against {@link POLICY_RUBRIC} and returns a
 *      binary disposition + matched categories + rationale.
 *
 * The gate fails **closed**: if no language-model provider is configured the
 * review cannot produce an `allow`, so the app stays unapproved. Every run is
 * persisted to the append-only `app_reviews` table for audit.
 */

import { generateObject } from "ai";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { dbRead, dbWrite } from "../../db/client";
import { type AppReview, appReviews } from "../../db/schemas/app-reviews";
import { type App, apps } from "../../db/schemas/apps";
import { getLanguageModel, hasLanguageModelProviderConfigured } from "../providers/language-model";
import { logger } from "../utils/logger";
import { appsService } from "./apps";

/** Bump when the rubric or category taxonomy changes so old rows stay attributable. */
export const RUBRIC_VERSION = "2026-07-01.1";

/**
 * Classifier model. `APP_REVIEW_MODEL` wins; otherwise pick a small, capable
 * model from whichever provider the cloud actually has configured so the gate
 * works out-of-the-box (OpenAI → Anthropic → Cerebras → Groq). Falls back to
 * the first candidate, and `classifyCandidate` fails closed if none is usable.
 */
const REVIEW_MODEL_CANDIDATES = [
  "gpt-4o-mini",
  "claude-haiku-4-5-20251001",
  "gpt-oss-120b",
  "llama-3.3-70b",
];

export function getAppReviewModelId(): string {
  const explicit = process.env.APP_REVIEW_MODEL?.trim();
  if (explicit) return explicit;
  for (const model of REVIEW_MODEL_CANDIDATES) {
    if (hasLanguageModelProviderConfigured(model)) return model;
  }
  return REVIEW_MODEL_CANDIDATES[0];
}

/**
 * Policy taxonomy — US-illegal categories plus Stripe/OxaPay prohibited &
 * restricted businesses. US-only, no per-country dimension. Each category has a
 * deterministic keyword set used by the cheap pre-filter; the LLM sees the prose
 * rubric below and may match categories the keywords miss.
 */
export const POLICY_CATEGORIES: ReadonlyArray<{
  id: string;
  label: string;
  keywords: string[];
}> = [
  {
    id: "csam",
    label: "Child sexual abuse material / minors",
    keywords: ["child porn", "csam", "underage sex", "loli", "cp trade", "minor nudes"],
  },
  {
    id: "illegal_drugs",
    label: "Illegal drugs & controlled substances",
    keywords: [
      "buy cocaine",
      "sell heroin",
      "meth for sale",
      "fentanyl",
      "mdma for sale",
      "illegal narcotics",
      "unprescribed opioids",
      "research chemicals drugs",
    ],
  },
  {
    id: "weapons",
    label: "Weapons, firearms, explosives & ammunition sales",
    keywords: [
      "buy a gun",
      "firearms for sale",
      "ghost gun",
      "3d printed gun",
      "sell ammunition",
      "explosives for sale",
      "silencer for sale",
      "untraceable firearm",
    ],
  },
  {
    id: "counterfeit",
    label: "Counterfeit goods & intellectual-property infringement",
    keywords: [
      "counterfeit",
      "replica designer",
      "knockoff",
      "fake rolex",
      "pirated software",
      "cracked license keys",
    ],
  },
  {
    id: "fraud_scams",
    label: "Fraud, scams, stolen data & financial crime enablement",
    keywords: [
      "stolen credit cards",
      "cvv dump",
      "fullz",
      "carding",
      "money laundering",
      "ponzi",
      "guaranteed returns investment",
      "fake reviews for sale",
      "account takeover service",
    ],
  },
  {
    id: "malware_hacking",
    label: "Malware, hacking-for-hire & credential theft",
    keywords: [
      "ransomware",
      "malware builder",
      "ddos for hire",
      "hacking service",
      "phishing kit",
      "keylogger for sale",
      "botnet rental",
    ],
  },
  {
    id: "illegal_gambling",
    label: "Unlicensed gambling & lottery",
    keywords: ["unlicensed casino", "illegal betting", "rigged lottery", "underground poker ring"],
  },
  {
    id: "sexual_services",
    label: "Prostitution & sexual services / human trafficking",
    keywords: ["prostitution", "escort service booking", "sex trafficking", "buy sex"],
  },
  {
    id: "regulated_no_license",
    label: "Regulated goods sold without a license (prescription meds, tobacco/vape to minors)",
    keywords: [
      "prescription drugs without prescription",
      "sell prescription meds",
      "buy antibiotics no rx",
      "nicotine to minors",
    ],
  },
  {
    id: "terrorism_violence",
    label: "Terrorism, violent extremism & incitement",
    keywords: [
      "fund terrorism",
      "join isis",
      "make a bomb",
      "assassination service",
      "hire a hitman",
    ],
  },
  {
    id: "wildlife_human_parts",
    label: "Endangered wildlife, human organs & remains",
    keywords: ["ivory for sale", "buy human organs", "endangered species trade", "sell kidney"],
  },
  {
    id: "high_risk_crypto_scheme",
    label: "Deceptive crypto schemes (rug pulls, guaranteed-yield, mixer/laundering)",
    keywords: [
      "rug pull",
      "guaranteed crypto yield",
      "coin mixer laundering",
      "pump and dump signals",
    ],
  },
];

/**
 * Prose rubric handed to the LLM. Kept verbatim + versioned so a reviewer can
 * reconstruct the exact policy a decision was made under.
 */
export const POLICY_RUBRIC = `You are an automated compliance reviewer for the Eliza Cloud app marketplace. Eliza Cloud (a US/Delaware company) is the merchant of record and sells credits through Stripe and OxaPay. You must decide, with NO moral or ethical judgement, whether letting this app take payments would (a) violate US federal law, or (b) get our Stripe or OxaPay accounts frozen or terminated under their prohibited/restricted-business policies. Scope is US-only.

Return "ban" if the app's purpose, listing, or declared behavior falls into ANY of these categories:
- Child sexual abuse material or any sexualization of minors.
- Sale/distribution of illegal drugs or controlled substances, or regulated pharmaceuticals without a license/prescription.
- Sale of firearms, ammunition, explosives, weapon parts, or untraceable/3D-printed guns.
- Counterfeit goods, replicas, or intellectual-property/piracy infringement (pirated media, cracked software, stolen license keys).
- Fraud or financial crime enablement: stolen cards/CVV/"fullz", carding, money laundering, Ponzi/pyramid or "guaranteed return" investment schemes, fake-review or engagement fraud, account-takeover services.
- Malware, ransomware, hacking-for-hire, phishing kits, credential theft, DDoS-for-hire, botnets.
- Unlicensed gambling, betting, or lottery operations.
- Prostitution, escort booking, or any human-trafficking facilitation.
- Terrorism, violent extremism, incitement to violence, or murder-for-hire.
- Trade in endangered wildlife, human organs, or human remains.
- Deceptive crypto schemes: rug pulls, guaranteed-yield programs, laundering/mixing services, coordinated pump-and-dump.

Return "allow" for ordinary lawful software: productivity, entertainment, education, developer tools, art/generation, chat assistants, analytics, commerce of lawful goods, SaaS, games, and similar. Adult content that is lawful and consensual (18+) is allowed UNLESS it involves any category above. Mere mention of a prohibited topic in an educational, harm-reduction, or clearly-fictional context is NOT grounds for a ban — ban only when the app's actual function is to transact in or facilitate a prohibited category.

Respond with: disposition ("allow" or "ban"), matchedCategories (array of short category ids from the ban list, empty when allowing), and a one-sentence rationale a creator can act on.`;

// All fields required + no string length constraints: OpenAI strict structured
// output rejects optional properties and min/max keywords.
const ClassifierSchema = z.object({
  disposition: z.enum(["allow", "ban"]),
  matchedCategories: z.array(z.string()),
  rationale: z.string(),
});

export interface AppReviewCandidate {
  document: string;
  contentHash: string;
}

/**
 * Assemble the review-relevant fields into a stable candidate document and a
 * change-detection hash. Only fields that change the compliance picture are
 * included, so cosmetic edits (logo, analytics) don't force a re-review.
 */
export function buildReviewCandidate(
  app: Pick<App, "name" | "description" | "app_url" | "website_url" | "metadata">,
): AppReviewCandidate {
  const declaredTags = extractDeclaredTags(app.metadata);
  const document = [
    `Name: ${app.name ?? ""}`,
    `Description: ${app.description ?? ""}`,
    `App URL: ${app.app_url ?? ""}`,
    `Website: ${app.website_url ?? ""}`,
    declaredTags ? `Declared categories/features: ${declaredTags}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return { document, contentHash: stableHash(document) };
}

function extractDeclaredTags(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return "";
  const parts: string[] = [];
  for (const key of ["category", "categories", "tags", "features", "keywords"]) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value))
      parts.push(value.filter((v) => typeof v === "string").join(", "));
  }
  return parts.join("; ");
}

/**
 * Deterministic 64-bit FNV-1a hash rendered as hex. Used only for change
 * detection (not security), so it needs no crypto and is safe in every runtime.
 */
export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface PreFilterResult {
  matched: boolean;
  categories: string[];
}

/** Cheap deterministic keyword pass. Bans obvious prohibited listings pre-LLM. */
export function preFilter(document: string): PreFilterResult {
  const haystack = document.toLowerCase();
  const categories: string[] = [];
  for (const category of POLICY_CATEGORIES) {
    if (category.keywords.some((kw) => haystack.includes(kw))) {
      categories.push(category.id);
    }
  }
  return { matched: categories.length > 0, categories };
}

export interface ClassifierResult {
  disposition: "allow" | "ban";
  matchedCategories: string[];
  rationale: string;
  preFilterMatched: boolean;
  model: string | null;
  modelProvider: string | null;
}

/**
 * Classify a candidate document: deterministic pre-filter first, then the LLM.
 * Throws if the app needs the LLM (no pre-filter match) but no provider is
 * configured — the caller must treat that as "cannot approve" (fail closed).
 */
export async function classifyCandidate(document: string): Promise<ClassifierResult> {
  const pre = preFilter(document);
  if (pre.matched) {
    return {
      disposition: "ban",
      matchedCategories: pre.categories,
      rationale: `Automatically rejected: listing matches prohibited category keywords (${pre.categories.join(", ")}).`,
      preFilterMatched: true,
      model: null,
      modelProvider: null,
    };
  }

  const modelId = getAppReviewModelId();
  if (!hasLanguageModelProviderConfigured(modelId)) {
    throw new Error(
      `[AppReview] No language-model provider configured for "${modelId}"; cannot approve app (set APP_REVIEW_MODEL and the matching provider key).`,
    );
  }

  const { object } = await generateObject({
    model: getLanguageModel(modelId),
    schema: ClassifierSchema,
    system: POLICY_RUBRIC,
    prompt: `Review this app listing and decide allow or ban.\n\n${document}`,
    temperature: 0,
    maxRetries: 2,
  });

  return {
    disposition: object.disposition,
    matchedCategories: object.disposition === "ban" ? object.matchedCategories : [],
    rationale: object.rationale,
    preFilterMatched: false,
    model: modelId,
    modelProvider: providerOf(modelId),
  };
}

function providerOf(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic";
  if (id.includes("gpt-oss") || id.includes("cerebras") || id.includes("gemma")) return "cerebras";
  if (id.includes("gpt") || id.includes("o1") || id.includes("o3")) return "openai";
  if (id.includes("groq") || id.includes("llama")) return "groq";
  return "unknown";
}

export interface RunAppReviewParams {
  app: App;
  triggeredByUserId?: string | null;
  trajectoryRef?: string | null;
}

/**
 * Run a review for an app, persist the audit row, and mirror the decision onto
 * `apps.review_status` / `review_content_hash` / `reviewed_at`. Returns the
 * written review row.
 */
export async function runAppReview(params: RunAppReviewParams): Promise<AppReview> {
  const { app, triggeredByUserId = null, trajectoryRef = null } = params;
  const candidate = buildReviewCandidate(app);
  const result = await classifyCandidate(candidate.document);

  const reviewStatus = result.disposition === "allow" ? "approved" : "rejected";
  const now = new Date();

  const review = await dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .insert(appReviews)
      .values({
        app_id: app.id,
        triggered_by_user_id: triggeredByUserId,
        disposition: result.disposition,
        matched_categories: result.matchedCategories,
        rationale: result.rationale,
        pre_filter_matched: result.preFilterMatched,
        rubric_version: RUBRIC_VERSION,
        model_provider: result.modelProvider,
        model: result.model,
        content_hash: candidate.contentHash,
        candidate_document: candidate.document,
        trajectory_ref: trajectoryRef,
      })
      .returning();

    await tx
      .update(apps)
      .set({
        review_status: reviewStatus,
        review_content_hash: candidate.contentHash,
        reviewed_at: now,
        updated_at: now,
        // A rejection revokes monetization entirely — "a rejected re-review
        // DOES cut everything off" (invariant at api/v1/apps/[id]/route.ts).
        // Without this, an app that enabled monetization while approved kept
        // `monetization_enabled = true` after a ban, and the inference-markup
        // earnings path (app-credits.ts, gated on that flag — only NEW paid
        // charges check isAppMonetizationApproved) kept paying the creator.
        // Pricing fields are preserved; re-enabling goes back through
        // PUT /apps/:id/monetization, which requires a fresh approval.
        ...(reviewStatus === "rejected" ? { monetization_enabled: false } : {}),
      })
      .where(eq(apps.id, app.id));

    return row;
  });

  // The review just changed apps.review_status in the DB, but appsService caches
  // the app row (getById, TTL 300s) — the monetization/charge gates read through
  // that cache via isAppMonetizationApproved. Without this invalidation an
  // approval 403s legit creators for up to 5 min, and a re-review to REJECTED
  // leaves the payment gate reading a stale "approved" row. Mirrors the
  // invalidate-on-mutation invariant documented at apps.ts:105-111. Best-effort:
  // a cache-eviction failure must not fail the (already-committed) review.
  try {
    await appsService.invalidateCache(app.id, app.api_key_id ?? undefined, app.slug ?? undefined);
  } catch (err) {
    logger.warn("[AppReview] cache invalidation after review failed", {
      appId: app.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("[AppReview] Completed review", {
    appId: app.id,
    disposition: result.disposition,
    reviewStatus,
    preFilter: result.preFilterMatched,
    model: result.model,
    matched: result.matchedCategories,
  });

  return review;
}

/**
 * True when the app is cleared to monetize / take payments: it is `approved`
 * AND its current review-relevant content still matches what was approved
 * (a material change since approval re-gates it).
 */
export function isAppMonetizationApproved(app: App): boolean {
  if (app.review_status !== "approved") return false;
  // Grandfathered rows (approved by the backfill migration, before the review
  // system existed) carry no snapshot hash — treat them as approved. Apps that
  // went through the automated review have a hash and are strictly re-gated when
  // their reviewed content changes.
  if (!app.review_content_hash) return true;
  const { contentHash } = buildReviewCandidate(app);
  return app.review_content_hash === contentHash;
}

/** Most-recent review row for an app (the current decision), or null. */
export async function getLatestAppReview(appId: string): Promise<AppReview | null> {
  const [row] = await dbRead
    .select()
    .from(appReviews)
    .where(eq(appReviews.app_id, appId))
    .orderBy(desc(appReviews.created_at))
    .limit(1);
  return row ?? null;
}
