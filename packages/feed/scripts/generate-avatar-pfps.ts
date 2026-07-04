/**
 * Avatar profile-picture generator for Feed actor assets.
 * It combines visual subject, place, and style prompts before sending image jobs to the configured generation service.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fal } from "@fal-ai/client";

const ANIMALS = [
  "dragon",
  "red panda",
  "axolotl",
  "fennec fox",
  "otter",
  "raccoon",
  "hedgehog",
  "owl",
  "bunny",
  "corgi",
  "shiba inu",
  "cat",
  "penguin",
  "koala",
  "hamster",
  "fox",
  "deer",
  "duckling",
  "frog",
  "chameleon",
  "panda",
  "sloth",
  "capybara",
  "chinchilla",
  "sugar glider",
  "seal",
  "narwhal",
  "platypus",
  "quokka",
  "tanuki",
  "pangolin",
  "armadillo",
  "bat",
  "firefly squid",
  "jellyfish",
  "octopus",
  "sea turtle",
  "koi fish",
  "mantis shrimp",
  "phoenix",
  "griffin",
  "unicorn",
  "jackalope",
  "moon rabbit",
  "star whale",
  "cloud serpent",
  "crystal golem",
  "mushroom sprite",
  "moss fox",
  "ember cat",
];

const SF_LANDMARKS = [
  "the Golden Gate Bridge",
  "Alcatraz Island",
  "Fisherman's Wharf",
  "Lombard Street",
  "Chinatown Gate",
  "the Painted Ladies at Alamo Square",
  "Coit Tower",
  "the Palace of Fine Arts",
  "Twin Peaks",
  "the Transamerica Pyramid",
  "Pier 39 with sea lions",
  "Golden Gate Park",
  "the Ferry Building",
  "Ghirardelli Square",
  "the Cable Cars on Powell Street",
  "Sutro Baths ruins",
  "Baker Beach",
  "the de Young Museum",
  "Salesforce Tower",
  "Mission Dolores Park",
  "the Castro Theatre",
  "Ocean Beach",
  "Land's End trail",
  "the Cliff House ruins",
  "Treasure Island with city skyline",
  "the Embarcadero waterfront",
  "Fort Point under the bridge",
  "Japanese Tea Garden",
  "Haight-Ashbury neighborhood",
  "the San Francisco City Hall dome",
];

const OCCUPATIONS = [
  // Black Hat
  "evil scammer",
  "relentless crypto shill",
  "FUD spreader",
  "pump & dump schemer",
  "info seller",
  "insider trader",
  "disinfo agent",
  "internet troll",
  "market manipulator",
  // Gray Hat
  "mysterious double agent",
  "intel gatherer",
  "reply guy",
  "momentum trader",
  "info broker",
  "crypto influencer",
  "cunning strategist",
  "obsessive researcher",
  "gossip collector",
  // White Hat
  "wise predictor",
  "community builder",
  "alpha caller",
  "friendly networker",
  "value investor",
  "scam reporter",
  "patient educator",
  "risk manager",
  "relationship builder",
];

interface AvatarSpec {
  index: number;
  animal: string;
  landmark: string;
  occupation: string;
  prompt: string;
}

function buildPrompt(
  animal: string,
  occupation: string,
  landmark: string,
): string {
  return `a close-up portrait profile picture of a cute little ${animal} who is a ${occupation}, waist-up shot focused on their face, with ${landmark} in the background, drawn in a 3D pixar style, centered composition`;
}

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateSpecs(): AvatarSpec[] {
  const rand = seededRandom(42);
  const specs: AvatarSpec[] = [];
  const seen = new Set<string>();

  const animals = shuffle(ANIMALS, rand);
  const landmarks = shuffle(SF_LANDMARKS, rand);
  const occupations = shuffle(OCCUPATIONS, rand);

  let ai = 0,
    li = 0,
    oi = 0;

  while (specs.length < 150) {
    const animal = animals[ai % animals.length];
    const landmark = landmarks[li % landmarks.length];
    const occupation = occupations[oi % occupations.length];

    const key = `${animal}|${landmark}|${occupation}`;
    if (!seen.has(key)) {
      seen.add(key);
      specs.push({
        index: specs.length,
        animal,
        landmark,
        occupation,
        prompt: buildPrompt(animal, occupation, landmark),
      });
    }

    // Rotate through lists at different rates for variety
    ai++;
    li += 3;
    oi += 7;
  }

  return specs;
}

const CONCURRENCY = 20;
const TIMEOUT_MS = 120_000; // 2 min per image max
const OUTPUT_DIR = join(import.meta.dir, "..", "output", "avatar-pfps");

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms,
      ),
    ),
  ]);
}

async function generateImage(spec: AvatarSpec): Promise<void> {
  const filename = `${String(spec.index).padStart(3, "0")}_${spec.animal.replace(/\s+/g, "-")}_${spec.occupation.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const outPath = join(OUTPUT_DIR, filename);

  // Skip existing files (for resume support)
  if (existsSync(outPath)) {
    console.log(`[${spec.index + 1}/150] Skipping (exists): ${filename}`);
    return;
  }

  console.log(
    `[${spec.index + 1}/150] Generating: ${spec.animal} / ${spec.occupation} / ${spec.landmark}`,
  );

  try {
    const result = await withTimeout(
      fal.subscribe("fal-ai/nano-banana-2", {
        input: {
          prompt: spec.prompt,
          num_images: 1,
          resolution: "1K",
          aspect_ratio: "1:1",
          output_format: "png",
          limit_generations: true,
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            update.logs
              ?.map((log) => log.message)
              .forEach((m) => console.log(`  [queue] ${m}`));
          }
        },
      }),
      TIMEOUT_MS,
      filename,
    );

    // Download the image
    const images = (result.data as Record<string, unknown>)?.images as
      | Array<{ url: string }>
      | undefined;
    const imageUrl = images?.[0]?.url;
    if (!imageUrl) {
      console.error(`  ✗ No image URL for ${spec.index}`);
      return;
    }

    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    await writeFile(outPath, Buffer.from(buffer));
    console.log(`  ✓ Saved ${filename}`);
  } catch (err: unknown) {
    console.error(
      `  ✗ Failed ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main() {
  const specs = generateSpecs();

  // If --dry-run, just print the specs
  if (process.argv.includes("--dry-run")) {
    console.log("=== DRY RUN: 150 Avatar Specs ===\n");
    for (const spec of specs) {
      console.log(
        `${String(spec.index + 1).padStart(3, " ")}. ${spec.animal} | ${spec.occupation} | ${spec.landmark}`,
      );
    }
    console.log("\n--- Occupation distribution ---");
    const occCounts: Record<string, number> = {};
    for (const s of specs) {
      occCounts[s.occupation] = (occCounts[s.occupation] || 0) + 1;
    }
    for (const [occ, count] of Object.entries(occCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${occ}: ${count}`);
    }
    console.log("\n--- Animal distribution ---");
    const animalCounts: Record<string, number> = {};
    for (const s of specs) {
      animalCounts[s.animal] = (animalCounts[s.animal] || 0) + 1;
    }
    for (const [a, count] of Object.entries(animalCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${a}: ${count}`);
    }
    return;
  }

  // Real generation
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(
    `Generating 150 avatar profile pictures (concurrency: ${CONCURRENCY})...\n`,
  );

  // Process in batches
  for (let i = 0; i < specs.length; i += CONCURRENCY) {
    const batch = specs.slice(i, i + CONCURRENCY);
    console.log(
      `\n── Batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(specs.length / CONCURRENCY)} ──`,
    );
    await Promise.all(batch.map(generateImage));
  }

  const generated = specs.filter((s) => {
    const fn = `${String(s.index).padStart(3, "0")}_${s.animal.replace(/\s+/g, "-")}_${s.occupation.replace(/[^a-z0-9]+/gi, "-")}.png`;
    return existsSync(join(OUTPUT_DIR, fn));
  }).length;

  console.log(`\n✓ Done! ${generated}/150 avatars generated.`);
  if (generated < 150) {
    console.log(
      "  Re-run the script to retry failed ones (skip-existing is on).",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
