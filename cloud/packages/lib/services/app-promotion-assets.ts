import { generateText, streamText } from "ai";
import { z } from "zod";
import type { App } from "@/db/repositories";
import { uploadToBlob } from "@/lib/blob";
import {
  mergeAnthropicCotProviderOptions,
  mergeGoogleImageModalitiesWithAnthropicCot,
} from "@/lib/providers/anthropic-thinking";
import { getLanguageModel } from "@/lib/providers/language-model";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { contentSafetyService } from "@/lib/services/content-safety";
import { parseAiJson } from "@/lib/utils/ai-json-parse";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";

const IMAGE_MODEL = "google/gemini-2.5-flash-image";

export const AD_SIZES = {
  facebook_feed: { width: 1200, height: 628 },
  facebook_story: { width: 1080, height: 1920 },
  instagram_square: { width: 1080, height: 1080 },
  instagram_story: { width: 1080, height: 1920 },
  twitter_card: { width: 1200, height: 675 },
  linkedin_post: { width: 1200, height: 627 },
  google_display_leaderboard: { width: 728, height: 90 },
  google_display_medium: { width: 300, height: 250 },
  google_display_large: { width: 336, height: 280 },
} as const;

export type AdSize = keyof typeof AD_SIZES;

export interface GeneratedAsset {
  type: "screenshot" | "social_card" | "banner";
  size: { width: number; height: number };
  url: string;
  format: "png" | "jpg" | "webp";
  generatedAt: Date;
}

export interface AdCopyVariants {
  headlines: string[];
  descriptions: string[];
  callToActions: string[];
  hashtags: string[];
}

const AdCopyVariantsSchema = z.object({
  headlines: z.array(z.string()),
  descriptions: z.array(z.string()),
  callToActions: z.array(z.string()),
  hashtags: z.array(z.string()),
});

interface WebsiteContext {
  title?: string;
  description?: string;
  keywords?: string[];
  ogImage?: string;
  mainHeading?: string;
  features?: string[];
  industry?: string;
  productType?: string;
}

class AppPromotionAssetsService {
  // Cache website context to avoid re-fetching
  private websiteContextCache = new Map<string, WebsiteContext>();

  /**
   * Fetch and analyze website content for better image generation
   */
  private async fetchWebsiteContext(url: string): Promise<WebsiteContext> {
    // Check cache first
    const cached = this.websiteContextCache.get(url);
    if (cached) {
      return cached;
    }

    const context: WebsiteContext = {};

    // Skip placeholder URLs
    if (!url || url.includes("placeholder")) {
      return context;
    }

    let safeUrl: URL;
    try {
      safeUrl = await assertSafeOutboundUrl(url);
    } catch (_error) {
      logger.warn("[PromotionAssets] Blocked internal URL", { url });
      return context;
    }

    try {
      logger.info("[PromotionAssets] Fetching website context", {
        url: safeUrl.toString(),
      });

      const response = await Promise.race([
        fetch(safeUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ElizaCloudBot/1.0; +https://www.elizacloud.ai)",
            Accept: "text/html",
          },
          redirect: "error",
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10_000)),
      ]);

      if (!response.ok) {
        logger.warn("[PromotionAssets] Failed to fetch website", {
          url,
          status: response.status,
        });
        return context;
      }

      const html = await response.text();

      // Extract metadata from HTML
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) context.title = titleMatch[1].trim();

      const descMatch = html.match(
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      );
      if (descMatch) context.description = descMatch[1].trim();

      const ogDescMatch = html.match(
        /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
      );
      if (ogDescMatch && !context.description) {
        context.description = ogDescMatch[1].trim();
      }

      const ogImageMatch = html.match(
        /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      );
      if (ogImageMatch) context.ogImage = ogImageMatch[1].trim();

      const keywordsMatch = html.match(
        /<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i,
      );
      if (keywordsMatch) {
        context.keywords = keywordsMatch[1]
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      }

      // Extract main heading (h1)
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1Match) context.mainHeading = h1Match[1].trim();

      // Analyze content to detect product type and industry
      const _lowerHtml = html.toLowerCase();
      const combinedText =
        `${context.title || ""} ${context.description || ""} ${context.mainHeading || ""}`.toLowerCase();

      // Detect product type
      if (
        combinedText.includes("saas") ||
        combinedText.includes("software as a service") ||
        combinedText.includes("subscription")
      ) {
        context.productType = "SaaS Platform";
      } else if (
        combinedText.includes("api") ||
        combinedText.includes("developer") ||
        combinedText.includes("sdk")
      ) {
        context.productType = "Developer Tool / API";
      } else if (
        combinedText.includes("ai") ||
        combinedText.includes("artificial intelligence") ||
        combinedText.includes("machine learning") ||
        combinedText.includes("agent")
      ) {
        context.productType = "AI-Powered Application";
      } else if (
        combinedText.includes("crypto") ||
        combinedText.includes("blockchain") ||
        combinedText.includes("web3") ||
        combinedText.includes("defi")
      ) {
        context.productType = "Web3 / Blockchain";
      } else if (
        combinedText.includes("e-commerce") ||
        combinedText.includes("shop") ||
        combinedText.includes("store")
      ) {
        context.productType = "E-commerce";
      } else if (
        combinedText.includes("analytics") ||
        combinedText.includes("dashboard") ||
        combinedText.includes("metrics")
      ) {
        context.productType = "Analytics Platform";
      } else if (
        combinedText.includes("marketing") ||
        combinedText.includes("automation") ||
        combinedText.includes("campaign")
      ) {
        context.productType = "Marketing Tool";
      } else if (combinedText.includes("landing page")) {
        context.productType = "Landing Page Builder";
      }

      // Detect industry
      if (
        combinedText.includes("finance") ||
        combinedText.includes("fintech") ||
        combinedText.includes("payment")
      ) {
        context.industry = "Fintech";
      } else if (combinedText.includes("health") || combinedText.includes("medical")) {
        context.industry = "Healthcare";
      } else if (combinedText.includes("education") || combinedText.includes("learning")) {
        context.industry = "EdTech";
      } else if (combinedText.includes("real estate") || combinedText.includes("property")) {
        context.industry = "Real Estate";
      }

      // Extract feature-like content (look for lists)
      const featureMatches = html.match(/<li[^>]*>([^<]{10,100})<\/li>/gi);
      if (featureMatches && featureMatches.length > 0) {
        context.features = featureMatches
          .slice(0, 5)
          .map((m) => m.replace(/<[^>]+>/g, "").trim())
          .filter((f) => f.length > 10 && f.length < 100);
      }

      logger.info("[PromotionAssets] Website context extracted", {
        url,
        title: context.title,
        productType: context.productType,
        industry: context.industry,
        hasFeatures: !!context.features?.length,
      });

      // Cache the result
      this.websiteContextCache.set(url, context);
      return context;
    } catch (error) {
      logger.warn("[PromotionAssets] Error fetching website context", {
        url,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return context;
    }
  }

  /**
   * Generate a single promotional image
   * @param customPrompt - Optional user-provided context to guide image generation
   */
  async generateSocialCard(
    app: App,
    size: AdSize = "twitter_card",
    customPrompt?: string,
  ): Promise<GeneratedAsset | null> {
    const dimensions = AD_SIZES[size];

    // Fetch website context for better image generation
    const websiteUrl = app.website_url || app.app_url;
    let websiteContext: WebsiteContext = {};

    try {
      if (websiteUrl && !websiteUrl.includes("placeholder")) {
        websiteContext = await this.fetchWebsiteContext(websiteUrl);
      }
    } catch (error) {
      logger.warn("[PromotionAssets] Failed to fetch website context", {
        url: websiteUrl,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    let prompt = this.buildImagePrompt(app, size, websiteContext, customPrompt);

    // Truncate prompt if too long (some models have limits)
    const MAX_PROMPT_LENGTH = 4000;
    if (prompt.length > MAX_PROMPT_LENGTH) {
      logger.info("[PromotionAssets] Truncating long prompt", {
        originalLength: prompt.length,
        truncatedLength: MAX_PROMPT_LENGTH,
      });
      prompt = prompt.slice(0, MAX_PROMPT_LENGTH);
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "promotion_asset_prompt",
      organizationId: app.organization_id,
      appId: app.id,
      text: [
        `App name: ${app.name}`,
        app.description ? `App description: ${app.description}` : undefined,
        customPrompt ? `Custom prompt: ${customPrompt}` : undefined,
        `Image prompt: ${prompt}`,
      ],
      metadata: { size },
    });

    logger.info("[PromotionAssets] Generating image", {
      appId: app.id,
      size,
      hasCustomPrompt: !!customPrompt,
      promptLength: prompt.length,
      hasWebsiteContext: Object.keys(websiteContext).length > 0,
    });

    let imageBase64: string | null = null;
    let streamError: string | null = null;

    try {
      // Pass the model id as a string (matching /api/v1/generate-image) so the
      // AI SDK resolves an image-capable provider. mergeGoogleImageModalitiesWithAnthropicCot
      // sets responseModalities for Google models; CoT/thinking budget is a no-op
      // here because IMAGE_MODEL is not Anthropic.
      const result = streamText({
        model: IMAGE_MODEL,
        ...mergeGoogleImageModalitiesWithAnthropicCot(IMAGE_MODEL, process.env),
        prompt: `Generate a promotional banner image: ${prompt}`,
      });

      for await (const delta of result.fullStream) {
        if (delta.type === "error") {
          streamError = String(delta.error);
          logger.error("[PromotionAssets] Stream error", {
            appId: app.id,
            size,
            error: streamError,
          });
          break;
        }
        if (delta.type === "file" && delta.file.mediaType.startsWith("image/")) {
          const uint8Array = delta.file.uint8Array;
          const base64 = Buffer.from(uint8Array).toString("base64");
          imageBase64 = `data:${delta.file.mediaType};base64,${base64}`;
          break;
        }
      }
    } catch (error) {
      logger.error("[PromotionAssets] Image generation error", {
        appId: app.id,
        size,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!imageBase64) {
      logger.warn("[PromotionAssets] Failed to generate image - no image returned", {
        appId: app.id,
        size,
        streamError,
      });
      return null;
    }

    // Upload to R2 storage
    const buffer = Buffer.from(imageBase64.split(",")[1], "base64");

    logger.info("[PromotionAssets] Uploading to blob storage", {
      appId: app.id,
      size,
      bufferSize: buffer.length,
    });

    const blob = await uploadToBlob(buffer, {
      filename: `${size}-${Date.now()}.png`,
      contentType: "image/png",
      folder: `promotion-assets/${app.id}`,
    });

    await contentSafetyService.assertSafeForPublicUse({
      surface: "promotion_asset_output",
      organizationId: app.organization_id,
      appId: app.id,
      imageUrls: [blob.url],
      metadata: { size, format: "png" },
    });

    logger.info("[PromotionAssets] Image generated and uploaded", {
      appId: app.id,
      size,
      url: blob.url,
    });

    return {
      type: "social_card",
      size: dimensions,
      url: blob.url,
      format: "png",
      generatedAt: new Date(),
    };
  }

  /**
   * Generate ad banners - runs in parallel for speed
   */
  async generateAdBanners(app: App, sizes: AdSize[]): Promise<GeneratedAsset[]> {
    const results = await Promise.all(
      sizes.map(async (size) => {
        const asset = await this.generateSocialCard(app, size);
        if (!asset) return null;
        return { ...asset, type: "banner" } as GeneratedAsset;
      }),
    );
    return results.filter((a): a is GeneratedAsset => a !== null);
  }

  /**
   * Generate ad copy using AI - contextual based on app type
   */
  async generateAdCopy(
    app: App,
    targetAudience?: string,
    tone: "professional" | "casual" | "exciting" | "informative" = "professional",
  ): Promise<AdCopyVariants> {
    // Detect app category for better copy
    const description = (app.description || "").toLowerCase();
    const name = app.name.toLowerCase();
    const combinedText = `${name} ${description}`;

    let category = "tech product";
    let valueProps: string[] = ["innovative", "powerful", "easy to use"];

    if (combinedText.includes("saas") || combinedText.includes("platform")) {
      category = "SaaS platform";
      valueProps = ["scale your business", "save time", "boost productivity"];
    } else if (combinedText.includes("ai") || combinedText.includes("agent")) {
      category = "AI application";
      valueProps = ["AI-powered automation", "intelligent assistance", "24/7 availability"];
    } else if (combinedText.includes("crypto") || combinedText.includes("web3")) {
      category = "Web3 app";
      valueProps = ["decentralized", "secure", "transparent"];
    }

    const websiteUrl = app.website_url || app.app_url;

    await contentSafetyService.assertSafeForPublicUse({
      surface: "promotion_copy",
      organizationId: app.organization_id,
      appId: app.id,
      text: [
        `App name: ${app.name}`,
        app.description ? `App description: ${app.description}` : undefined,
        websiteUrl ? `Website: ${websiteUrl}` : undefined,
        targetAudience ? `Target audience: ${targetAudience}` : undefined,
        `Tone: ${tone}`,
      ],
      metadata: { stage: "input" },
    });

    const prompt = `You are a world-class copywriter for tech startups. Generate compelling advertising copy for this ${category}:

## App Details
Name: ${app.name}
Description: ${app.description || "An innovative application built on Eliza Cloud"}
Website: ${websiteUrl}
Category: ${category}
Key Value Props: ${valueProps.join(", ")}
${targetAudience ? `Target Audience: ${targetAudience}` : "Target Audience: Tech-savvy professionals, developers, entrepreneurs"}
Tone: ${tone}

## Requirements
Generate marketing copy that would work on Twitter, LinkedIn, and Meta ads.

Return JSON with these exact fields:
{
  "headlines": [
    // 5 punchy headlines, each UNDER 30 characters
    // Use power words: "Unlock", "Transform", "Supercharge", "Discover", "Master"
    // Focus on benefits, not features
  ],
  "descriptions": [
    // 5 compelling descriptions, each UNDER 90 characters  
    // Include specific benefits and outcomes
    // Create curiosity and FOMO
  ],
  "callToActions": [
    // 5 action-oriented CTAs
    // Examples: "Start Free", "See It Live", "Join Beta", "Get Access", "Try Demo"
  ],
  "hashtags": [
    // 5-8 relevant hashtags without the # symbol
    // Mix of: trending tech hashtags, niche hashtags, branded hashtags
  ]
}

Return ONLY valid JSON. No markdown, no explanation.`;

    const copyModel = "anthropic/claude-sonnet-4.6";
    // Note: When ANTHROPIC_COT_BUDGET is set, @ai-sdk/anthropic silently strips temperature,
    // topP, and topK when extended thinking is active. We explicitly disable extended thinking
    // (pass budget=0) to preserve temperature control for creative promotional content quality.
    const { text } = await generateText({
      model: getLanguageModel(copyModel),
      ...mergeAnthropicCotProviderOptions(copyModel, process.env, 0),
      temperature: 0.8,
      prompt,
    });

    const parsed = parseAiJson(text, AdCopyVariantsSchema, "ad copy variants");

    await contentSafetyService.assertSafeForPublicUse({
      surface: "promotion_copy",
      organizationId: app.organization_id,
      appId: app.id,
      text: [
        ...parsed.headlines.map((headline) => `Headline: ${headline}`),
        ...parsed.descriptions.map((description) => `Description: ${description}`),
        ...parsed.callToActions.map((callToAction) => `CTA: ${callToAction}`),
        ...parsed.hashtags.map((hashtag) => `Hashtag: ${hashtag}`),
      ],
      metadata: { stage: "output" },
    });

    return parsed;
  }

  /**
   * Generate a bundle of promotional assets - simplified and faster
   * Generates 1 social card + 1 banner in parallel, plus ad copy
   */
  async generateAssetBundle(
    app: App,
    options: {
      includeSocialCards?: boolean;
      includeAdBanners?: boolean;
      includeCopy?: boolean;
      targetAudience?: string;
      customPrompt?: string; // Optional user-provided context for image generation
    } = {},
  ): Promise<{
    assets: GeneratedAsset[];
    copy?: AdCopyVariants;
    errors: string[];
  }> {
    const errors: string[] = [];
    const imagePromises: Promise<GeneratedAsset | null>[] = [];

    // Generate social card (just 1 for speed)
    if (options.includeSocialCards !== false) {
      imagePromises.push(
        this.generateSocialCard(app, "twitter_card", options.customPrompt).catch((err) => {
          errors.push(`Failed to generate social card: ${extractErrorMessage(err)}`);
          return null;
        }),
      );
    }

    // Generate 1 banner (for speed - instagram_square is most versatile)
    if (options.includeAdBanners) {
      imagePromises.push(
        this.generateSocialCard(app, "instagram_square", options.customPrompt)
          .then((asset) => (asset ? ({ ...asset, type: "banner" } as GeneratedAsset) : null))
          .catch((err) => {
            errors.push(`Failed to generate banner: ${extractErrorMessage(err)}`);
            return null;
          }),
      );
    }

    // Generate copy in parallel with images
    const copyPromise =
      options.includeCopy !== false
        ? this.generateAdCopy(app, options.targetAudience).catch((err) => {
            errors.push(`Failed to generate copy: ${extractErrorMessage(err)}`);
            return undefined;
          })
        : Promise.resolve(undefined);

    // Wait for all in parallel
    const [imageResults, copy] = await Promise.all([Promise.all(imagePromises), copyPromise]);

    const assets = imageResults.filter((a): a is GeneratedAsset => a !== null);

    logger.info("[PromotionAssets] Asset bundle generated", {
      appId: app.id,
      assetCount: assets.length,
      hasCopy: !!copy,
      errorCount: errors.length,
      hasCustomPrompt: !!options.customPrompt,
    });

    return { assets, copy, errors };
  }

  private buildImagePrompt(
    app: App,
    size: AdSize,
    websiteContext: WebsiteContext = {},
    customPrompt?: string,
  ): string {
    const dimensions = AD_SIZES[size];
    const aspectRatio = dimensions.width / dimensions.height;

    // Use website context for richer understanding
    const websiteTitle = websiteContext.title || "";
    const websiteDesc = websiteContext.description || "";
    const mainHeading = websiteContext.mainHeading || "";
    const features = websiteContext.features || [];
    const productType = websiteContext.productType;
    const industry = websiteContext.industry;

    // Combine all text sources for analysis
    const description = (app.description || "").toLowerCase();
    const name = app.name.toLowerCase();
    const allText =
      `${name} ${description} ${websiteTitle} ${websiteDesc} ${mainHeading}`.toLowerCase();

    // Use detected product type from website, or fallback to text analysis
    let category = productType || "tech product";
    let visualTheme = "futuristic digital interface with glowing elements";
    let colorScheme = "deep blue and purple gradient with cyan accents";

    // If we have a detected product type, use specific visuals
    if (productType) {
      switch (productType) {
        case "SaaS Platform":
          visualTheme =
            "sleek dashboard mockup with floating UI cards, charts, and data visualizations";
          colorScheme = "dark navy to indigo gradient with electric blue highlights";
          break;
        case "Developer Tool / API":
          visualTheme =
            "code editor aesthetic with syntax highlighting, terminal windows, floating code snippets";
          colorScheme = "dark charcoal background with green terminal text and purple accents";
          break;
        case "AI-Powered Application":
          visualTheme =
            "neural network patterns, glowing synapses, abstract AI brain with flowing data streams";
          colorScheme = "black to deep purple gradient with neon pink and cyan glows";
          break;
        case "Web3 / Blockchain":
          visualTheme =
            "geometric blockchain patterns, interconnected nodes, digital ledger visualization";
          colorScheme = "dark charcoal to emerald green gradient with gold accents";
          break;
        case "Analytics Platform":
          visualTheme = "3D floating charts, real-time data streams, holographic metric displays";
          colorScheme = "dark mode with teal and lime green data highlights";
          break;
        case "Marketing Tool":
          visualTheme =
            "growth charts, social media icons, funnel visualizations, engagement metrics";
          colorScheme = "vibrant orange to magenta gradient with white accents";
          break;
        case "Landing Page Builder":
          visualTheme =
            "layered website wireframes, drag-and-drop elements, responsive device frames";
          colorScheme = "clean white to soft blue gradient with accent highlights";
          break;
        case "E-commerce":
          visualTheme = "shopping cart elements, product cards, checkout flow visualization";
          colorScheme = "warm coral to soft pink gradient with gold accents";
          break;
      }
    } else {
      // Fallback to text-based detection
      if (
        allText.includes("saas") ||
        allText.includes("software") ||
        allText.includes("subscription")
      ) {
        category = "SaaS platform";
        visualTheme = "sleek dashboard mockup with floating UI cards and data visualizations";
        colorScheme = "dark navy to indigo gradient with electric blue highlights";
      } else if (
        allText.includes("ai") ||
        allText.includes("agent") ||
        allText.includes("bot") ||
        allText.includes("chat") ||
        allText.includes("gpt")
      ) {
        category = "AI-powered application";
        visualTheme = "neural network patterns, glowing nodes, abstract AI brain visualization";
        colorScheme = "black to deep purple gradient with neon pink and cyan glows";
      } else if (
        allText.includes("defi") ||
        allText.includes("crypto") ||
        allText.includes("blockchain") ||
        allText.includes("web3") ||
        allText.includes("token")
      ) {
        category = "Web3/Crypto application";
        visualTheme = "geometric blockchain patterns, floating coins, digital vault aesthetic";
        colorScheme = "dark charcoal to green gradient with gold accents";
      } else if (
        allText.includes("game") ||
        allText.includes("gaming") ||
        allText.includes("play")
      ) {
        category = "gaming application";
        visualTheme = "dynamic action elements, game controller motifs, particle effects";
        colorScheme = "black to red gradient with orange fire effects";
      } else if (
        allText.includes("social") ||
        allText.includes("community") ||
        allText.includes("network")
      ) {
        category = "social platform";
        visualTheme = "connected people silhouettes, chat bubbles, community gathering";
        colorScheme = "warm sunset gradient with friendly orange tones";
      } else if (
        allText.includes("analytics") ||
        allText.includes("data") ||
        allText.includes("dashboard") ||
        allText.includes("metrics")
      ) {
        category = "analytics tool";
        visualTheme = "floating charts, data streams, holographic displays with metrics";
        colorScheme = "dark mode with teal and lime green data highlights";
      } else if (
        allText.includes("api") ||
        allText.includes("developer") ||
        allText.includes("sdk")
      ) {
        category = "developer tool";
        visualTheme = "code editor windows, terminal interfaces, API endpoint visualizations";
        colorScheme = "dark charcoal with green terminal highlights";
      }
    }

    // Add industry context if detected
    if (industry) {
      category = `${category} for ${industry}`;
    }

    // Size-specific composition
    let composition = "centered hero layout with depth layers";
    if (size.includes("story")) {
      composition =
        "vertical split with main visual on top, gradient fade at bottom for text overlay";
    } else if (size.includes("square")) {
      composition = "centered focal point with radial gradient background";
    } else if (size.includes("leaderboard")) {
      composition = "horizontal flow with left-to-right visual progression";
    }

    // Build feature context
    const featureContext =
      features.length > 0
        ? `\nKey features mentioned on website:\n${features.map((f) => `- ${f}`).join("\n")}`
        : "";

    // Build rich context from website
    const websiteInfo = [];
    if (websiteTitle && websiteTitle !== app.name) {
      websiteInfo.push(`Website Title: "${websiteTitle}"`);
    }
    if (websiteDesc) {
      websiteInfo.push(`Website Tagline: "${websiteDesc}"`);
    }
    if (mainHeading && mainHeading !== websiteTitle) {
      websiteInfo.push(`Main Heading: "${mainHeading}"`);
    }
    const websiteSection = websiteInfo.length > 0 ? websiteInfo.join("\n") : "";

    // Add user's custom prompt if provided
    const customSection = customPrompt
      ? `\n## User's Custom Instructions (IMPORTANT - Follow these closely)\n${customPrompt}\n`
      : "";

    return `Create a stunning ${dimensions.width}x${dimensions.height} promotional banner for "${app.name}" - a ${category}.

## About the Product
App Name: ${app.name}
Description: ${app.description || websiteDesc || "An innovative application"}
${websiteSection}
${featureContext}
${customSection}
## Visual Direction
Product Type: ${productType || category}
${industry ? `Industry: ${industry}` : ""}
Theme: ${visualTheme}
Color Palette: ${colorScheme}
Composition: ${composition}
Aspect Ratio: ${aspectRatio.toFixed(2)}:1

## Design Requirements
- Create a UNIQUE image that specifically represents THIS product, not a generic tech image
- The visual should clearly communicate what the product does at a glance
- Ultra-modern, premium quality design that stands out on social media
- Abstract representation of the product's core value proposition
- Dynamic depth with floating elements and subtle 3D perspective
- Atmospheric lighting with soft glows and highlights
- Professional gradient background that draws attention
- Visual hierarchy that guides the eye to the center
- NO TEXT, NO WORDS, NO LETTERS in the image - completely text-free
- Leave breathing room at edges for platform-specific safe zones
- High contrast elements for visibility on both light and dark feeds

The image should make viewers immediately understand this is a ${category} product.
Make it look like a premium tech company's marketing material that would appear on ProductHunt or TechCrunch.`;
  }

  getRecommendedSizes(platform: "meta" | "google" | "twitter" | "linkedin"): AdSize[] {
    const recommendations: Record<string, AdSize[]> = {
      meta: ["facebook_feed", "facebook_story", "instagram_square", "instagram_story"],
      google: ["google_display_leaderboard", "google_display_medium", "google_display_large"],
      twitter: ["twitter_card"],
      linkedin: ["linkedin_post"],
    };

    return recommendations[platform] || ["twitter_card"];
  }
}

export const appPromotionAssetsService = new AppPromotionAssetsService();
