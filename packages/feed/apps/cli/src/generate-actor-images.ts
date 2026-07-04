/**
 * One-shot CLI that generates profile pictures and banners for every actor and
 * organization via OpenAI's gpt-image-1.5, writing PNGs into `public/images/{actors,
 * actor-banners,organizations,org-banners}/`. Reads actor/org definitions from
 * `packages/engine/src/data/`, renders template prompts, and generates at most 3
 * images concurrently to stay under rate limits. Existing images are skipped
 * unless `--force` is passed. Requires `OPENAI_API_KEY` (gpt-image-1.5 is
 * OpenAI-only). PFPs/logos are square 1024x1024; banners are 1536x1024.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, join as pathJoin } from "node:path";
import { fal } from "@fal-ai/client";
import {
  actorBanner,
  actorPortrait,
  loadActorsData,
  organizationBanner,
  organizationLogo,
  renderPrompt,
} from "@feed/engine";
import { config } from "dotenv";
import { z } from "zod";
import { parseFlagValue } from "./cli-utils.js";
import { logger } from "./lib/logger.js";

// ─── CLI flags ────────────────────────────────────────────────────────────────
//
// --force           Delete existing images and regenerate everything
// --actor <id>      Only process images for a single actor (partial regeneration)
// --org <id>        Only process images for a single organization
//
// Examples:
//   bun run images -- --force
//   bun run images -- --actor ailon-musk
//   bun run images -- --org org-openagi

// Load environment variables — walk up to find .env at monorepo root
config({ path: pathJoin(import.meta.dir, "..", "..", "..", ".env") });
config(); // also load from CWD as fallback

const ActorSchema = z.object({
  id: z.string(),
  name: z.string(),
  realName: z.string().optional(),
  description: z.string(),
  domain: z.array(z.string()).optional(),
  personality: z.string().optional(),
  pfpDescription: z.string().optional(),
  profileBanner: z.string().optional(),
});
type Actor = z.infer<typeof ActorSchema>;

const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  pfpDescription: z.string().optional(),
  bannerDescription: z.string().optional(),
});
type Organization = z.infer<typeof OrganizationSchema>;

const ActorsDatabaseSchema = z.object({
  version: z.string().optional(),
  description: z.string().optional(),
  actors: z.array(ActorSchema),
  organizations: z.array(OrganizationSchema),
});

/**
 * Checks if a file exists at the given path
 */
async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

/**
 * Maps satirical organization IDs to their real-world company names
 *
 * Used to generate logo parodies that reference the original company's branding
 * while maintaining the satirical nature of the game.
 */
function getOriginalCompanyName(satiricalName: string, orgId: string): string {
  const mappings: Record<string, string> = {
    openlie: "OpenAGI",
    anthropimp: "Anthropic",
    anthoprick: "Anthropic",
    deepmined: "DeepMind",
    facehook: "Facebook/Meta",
    palantyrant: "Palantir",
    anduritalin: "Anduril",
    xitter: "Twitter/X",
    huskla: "Tesla",
    spacehusk: "SpaceX",
    neuraljank: "Neuralink",
    macrohard: "Microsoft",
    goolag: "Google",
    scamazon: "Amazon",
    crapple: "Apple",
    "faux-news": "Fox News",
    msdnc: "MSNBC",
    cnn: "CNN",
    "washout-post": "Washington Post",
    "the-new-york-crimes": "New York Times",
    "the-daily-liar": "The Daily Wire",
    microtreasury: "MicroStrategy",
    conbase: "Coinbase",
    ai16z: "Andreessen Horowitz (a16z)",
    taxifornia: "California",
    "loot-social": "Truth Social",
    "grift-social": "Truth Social",
    "dump-organization": "Trump Organization",
    "sucker-carlton-tonight": "Tucker Carlson Tonight",
    infobores: "InfoWars",
    "aimerica-first": "America First",
    cnbs: "CNBC",
    "the-fud": "Federal Reserve",
    nvidiot: "NVIDIA",
    blackcrook: "BlackRock",
    boomerberg: "Bloomberg",
    "wall-street-urinal": "Wall Street Journal",
    politicon: "Politico",
    "financial-crimes": "Financial Times",
    "ethereal-foundation": "Ethereum Foundation",
    angelgrift: "AngelList",
    angelfist: "AngelList",
    "founders-fraud": "Founders Fund",
    "ark-ingest": "ARK Invest",
    "larp-invest": "ARK Invest",
    "vulture-capital": "Social Capital",
    "department-of-war": "Department of Defense",
    "cia-inc": "CIA",
    "effective-authoritarianism": "Effective Altruism",
    goober: "Uber",
    "uber-but-worse": "Uber",
    "cloud-kitchens": "CloudKitchens",
    "all-in-podcast": "All-In Podcast",
    "craft-vultures": "Craft Ventures",
    "pirate-liars": "Pirate Wires",
    "network-grift-state": "The Network State",
    entropic: "Extropic",
    "dont-try-protocol": "Blueprint/Don't Die",
  };

  return mappings[orgId] || satiricalName;
}

// ─── fal.ai image generation ─────────────────────────────────────────────────
// Uses fal-ai/flux-pro for high-fidelity portrait generation.
// Returns a Buffer (JPEG) downloaded from the fal CDN URL.

const FAL_PORTRAIT_MODEL = "fal-ai/flux-pro/v1.1";
const FAL_BANNER_MODEL = "fal-ai/flux-pro/v1.1";

interface FalImageOutput {
  images?: Array<{ url: string; content_type?: string }>;
  image?: { url: string; content_type?: string };
}

async function falGenerate(
  prompt: string,
  aspectRatio: "1:1" | "3:2" | "16:9",
  model = FAL_PORTRAIT_MODEL,
): Promise<Buffer> {
  const result = await fal.subscribe(model, {
    input: {
      prompt,
      num_images: 1,
      aspect_ratio: aspectRatio,
      output_format: "jpeg",
      safety_tolerance: "5",
    },
    logs: false,
  });

  const output = result.data as FalImageOutput;
  const imageUrl = output?.images?.[0]?.url ?? output?.image?.url;

  if (!imageUrl) {
    throw new Error(`fal.ai returned no image URL (model: ${model})`);
  }

  const resp = await fetch(imageUrl);
  if (!resp.ok)
    throw new Error(`Failed to download image from fal CDN: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Generates a portrait PFP for an actor via fal.ai flux-pro.
 */
async function generateActorImage(actor: Actor): Promise<Buffer> {
  logger.info(`Generating profile picture for ${actor.name}...`);

  const descriptionParts = actor.description.split(".").slice(0, 3).join(". ");
  const prompt = renderPrompt(actorPortrait, {
    actorName: actor.name,
    realName: actor.realName || actor.name,
    pfpDescription: actor.pfpDescription!,
    descriptionParts,
    personality: actor.personality || "satirical",
  });

  const buf = await falGenerate(prompt, "1:1");
  logger.info(`Generated profile picture for ${actor.name}`);
  return buf;
}

/**
 * Generates a banner for an actor via fal.ai flux-pro.
 */
async function generateActorBannerImage(actor: Actor): Promise<Buffer> {
  logger.info(`Generating banner for ${actor.name}...`);

  if (!actor.profileBanner) {
    throw new Error(`Actor ${actor.name} is missing profileBanner field`);
  }

  const prompt = renderPrompt(actorBanner, {
    actorName: actor.name,
    realName: actor.realName || actor.name,
    profileBanner: actor.profileBanner,
  });

  const buf = await falGenerate(prompt, "3:2", FAL_BANNER_MODEL);
  logger.info(`Generated banner for ${actor.name}`);
  return buf;
}

/**
 * Generates a logo for an organization via fal.ai flux-pro.
 */
async function generateOrganizationImage(org: Organization): Promise<Buffer> {
  logger.info(`Generating logo for ${org.name}...`);

  if (!org.pfpDescription) {
    throw new Error(`Organization ${org.name} is missing pfpDescription field`);
  }

  const originalCompany = getOriginalCompanyName(org.name, org.id);
  const prompt = renderPrompt(organizationLogo, {
    organizationName: org.name,
    originalCompany,
    pfpDescription: org.pfpDescription,
    organizationType: org.type,
    organizationDescription: org.description,
  });

  const buf = await falGenerate(prompt, "1:1");
  logger.info(`Generated logo for ${org.name}`);
  return buf;
}

/**
 * Generates a banner for an organization via fal.ai flux-pro.
 */
async function generateOrganizationBannerImage(
  org: Organization,
): Promise<Buffer> {
  logger.info(`Generating banner for ${org.name}...`);

  if (!org.bannerDescription) {
    throw new Error(
      `Organization ${org.name} is missing bannerDescription field`,
    );
  }

  const originalCompany = getOriginalCompanyName(org.name, org.id);
  const prompt = renderPrompt(organizationBanner, {
    organizationName: org.name,
    originalCompany,
    bannerDescription: org.bannerDescription,
  });

  const buf = await falGenerate(prompt, "3:2", FAL_BANNER_MODEL);
  logger.info(`Generated banner for ${org.name}`);
  return buf;
}

/**
 * Saves a Buffer to a file
 */
async function saveImageBuffer(buf: Buffer, filepath: string): Promise<void> {
  await writeFile(filepath, buf);
  logger.info(`Saved image to ${filepath}`);
}

interface ImageJob {
  type: "actor-pfp" | "actor-banner" | "org-pfp" | "org-banner";
  id: string;
  name: string;
  outputPath: string;
  generator: () => Promise<Buffer>;
}

/**
 * Processes image generation jobs with concurrency control
 *
 * Uses max 3 concurrent jobs to respect OpenAI rate limits for high-quality
 * image generation. Each gpt-image-1.5 high-quality image can take up to
 * 2 minutes to generate.
 */
async function processQueue(
  jobs: ImageJob[],
  maxConcurrent = 3,
): Promise<{ generated: number; failed: number }> {
  let generated = 0;
  let failed = 0;
  const activeJobs = new Set<Promise<void>>();

  for (const job of jobs) {
    if (activeJobs.size >= maxConcurrent) {
      await Promise.race(activeJobs);
    }

    const jobPromise = (async () => {
      logger.info(
        `[${generated + failed + 1}/${jobs.length}] Generating ${job.type} for ${job.name}...`,
      );
      await job
        .generator()
        .then(async (buf) => {
          await saveImageBuffer(buf, job.outputPath);
          generated++;
          logger.info(
            `✅ [${generated}/${jobs.length}] Generated ${job.type} for ${job.name}`,
          );
        })
        .catch((error: Error) => {
          failed++;
          logger.error(`❌ Failed ${job.type} for ${job.name}`, error);
        });
    })();

    activeJobs.add(jobPromise);
    jobPromise.finally(() => activeJobs.delete(jobPromise));
  }

  await Promise.all(activeJobs);

  return { generated, failed };
}

/**
 * Main execution function for image generation CLI
 *
 * Orchestrates the complete image generation workflow:
 * 1. Validates OPENAI_API_KEY environment variable
 * 2. Loads actors database
 * 3. Checks for existing images (skips if present, unless --force)
 * 4. Builds generation job queue
 * 5. Processes jobs concurrently (max 3)
 * 6. Reports statistics
 */
async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // ignore
  }
}

async function main() {
  // Parse CLI flags
  const args = process.argv.slice(2);
  const forceRegenerate = args.includes("--force");
  const filterActorId = parseFlagValue(args, "--actor");
  const filterOrgId = parseFlagValue(args, "--org");

  if (filterActorId) {
    logger.info(`Filtering to single actor: ${filterActorId}`);
  }
  if (filterOrgId) {
    logger.info(`Filtering to single organization: ${filterOrgId}`);
  }
  if (forceRegenerate) {
    logger.info("--force: existing images will be deleted and regenerated");
  }

  logger.info("Checking actor and organization images...");
  logger.info(
    "Model: fal-ai/flux-pro | Quality: high | Format: jpeg | Provider: fal.ai",
  );

  if (forceRegenerate) {
    logger.info("--force flag detected: will regenerate ALL images");
  }

  // Image generation uses fal.ai (flux-pro). Set FAL_KEY in your .env.
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    logger.error("FAL_KEY is required for image generation.");
    logger.error("Add FAL_KEY to your .env file (get one at fal.ai).");
    process.exit(1);
  }

  // Configure fal.ai client
  fal.config({ credentials: falKey });

  // Load actors database using the engine package loader
  const parsedActors = loadActorsData();
  const actorsDb = ActorsDatabaseSchema.parse(parsedActors);

  // Paths are relative to the web app's public folder
  const webPublicDir = join(process.cwd(), "..", "web", "public");
  const actorsImagesDir = join(webPublicDir, "images", "actors");
  const actorsBannersDir = join(webPublicDir, "images", "actor-banners");
  const orgsImagesDir = join(webPublicDir, "images", "organizations");
  const orgsBannersDir = join(webPublicDir, "images", "org-banners");

  // Create directories if they don't exist
  await Promise.all([
    mkdir(actorsImagesDir, { recursive: true }),
    mkdir(actorsBannersDir, { recursive: true }),
    mkdir(orgsImagesDir, { recursive: true }),
    mkdir(orgsBannersDir, { recursive: true }),
  ]);

  let skippedCount = 0;
  const jobs: ImageJob[] = [];

  // Determine which actors/orgs to process
  const actorsToProcess = filterActorId
    ? actorsDb.actors.filter((a) => a.id === filterActorId)
    : actorsDb.actors;
  const orgsToProcess = filterOrgId
    ? actorsDb.organizations.filter((o) => o.id === filterOrgId)
    : filterActorId
      ? [] // --actor implies skip orgs unless --org also specified
      : actorsDb.organizations;

  if (filterActorId && actorsToProcess.length === 0) {
    logger.error(`No actor found with id "${filterActorId}"`);
    logger.info(
      "Available actor ids: " +
        actorsDb.actors
          .map((a) => a.id)
          .slice(0, 10)
          .join(", ") +
        "...",
    );
    process.exit(1);
  }

  if (filterOrgId && orgsToProcess.length === 0) {
    logger.error(`No organization found with id "${filterOrgId}"`);
    logger.info(
      "Available org ids: " +
        actorsDb.organizations
          .map((o) => o.id)
          .slice(0, 10)
          .join(", ") +
        "...",
    );
    process.exit(1);
  }

  // Build job queue for actor profile pictures
  logger.info(`Checking ${actorsToProcess.length} actor profile pictures...`);
  for (const actor of actorsToProcess) {
    const imagePath = join(actorsImagesDir, `${actor.id}.jpg`);

    if (forceRegenerate) {
      await deleteIfExists(imagePath);
    }

    if (await fileExists(imagePath)) {
      skippedCount++;
    } else {
      jobs.push({
        type: "actor-pfp",
        id: actor.id,
        name: actor.name,
        outputPath: imagePath,
        generator: () => generateActorImage(actor),
      });
    }
  }

  // Build job queue for actor banners
  logger.info(`Checking ${actorsToProcess.length} actor banners...`);
  for (const actor of actorsToProcess) {
    const bannerPath = join(actorsBannersDir, `${actor.id}.jpg`);

    if (forceRegenerate) {
      await deleteIfExists(bannerPath);
    }

    if (await fileExists(bannerPath)) {
      skippedCount++;
    } else {
      jobs.push({
        type: "actor-banner",
        id: actor.id,
        name: actor.name,
        outputPath: bannerPath,
        generator: () => generateActorBannerImage(actor),
      });
    }
  }

  // Build job queue for organization logos
  logger.info(`Checking ${orgsToProcess.length} organization logos...`);
  for (const org of orgsToProcess) {
    const imagePath = join(orgsImagesDir, `${org.id}.jpg`);

    if (forceRegenerate) {
      await deleteIfExists(imagePath);
    }

    if (await fileExists(imagePath)) {
      skippedCount++;
    } else {
      jobs.push({
        type: "org-pfp",
        id: org.id,
        name: org.name,
        outputPath: imagePath,
        generator: () => generateOrganizationImage(org),
      });
    }
  }

  // Build job queue for organization banners
  logger.info(`Checking ${orgsToProcess.length} organization banners...`);
  for (const org of orgsToProcess) {
    const bannerPath = join(orgsBannersDir, `${org.id}.jpg`);

    if (forceRegenerate) {
      await deleteIfExists(bannerPath);
    }

    if (await fileExists(bannerPath)) {
      skippedCount++;
    } else {
      jobs.push({
        type: "org-banner",
        id: org.id,
        name: org.name,
        outputPath: bannerPath,
        generator: () => generateOrganizationBannerImage(org),
      });
    }
  }

  logger.info(
    `Found ${jobs.length} images to generate (${skippedCount} already exist)`,
  );

  if (jobs.length === 0) {
    logger.info("All images already exist! Use --force to regenerate.");
    return;
  }

  // Process jobs with up to 3 concurrent operations (OpenAI rate limit safe)
  logger.info(
    "Starting concurrent generation (max 3 at a time, gpt-image-1.5 high quality)...",
  );
  const result = await processQueue(jobs, 3);

  logger.info("Complete!", {
    generated: result.generated,
    failed: result.failed,
    skipped: skippedCount,
    totalActors: actorsToProcess.length,
    totalOrganizations: orgsToProcess.length,
  });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: Error) => {
    logger.error("Fatal error:", error);
    process.exit(1);
  });
