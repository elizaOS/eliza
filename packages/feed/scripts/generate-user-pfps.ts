import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fal } from '@fal-ai/client';

// ── Subjects (animals, mythical creatures, characters) ───────────────
export const SUBJECTS = [
  // Animals — dignified and striking
  'a cat',
  'a wolf',
  'a fox',
  'an owl',
  'a bear',
  'a raven',
  'a koi fish',
  'a stag',
  'a tiger',
  'a hawk',
  'a panther',
  'a lion',
  'a dolphin',
  'a snow leopard',
  'an eagle',
  'a red panda',
  // Mythical
  'a dragon',
  'a phoenix',
  'a griffin',
  'a sphinx',
  'a valkyrie',
  'a celestial kirin',
  'a sea serpent',
  'a nine-tailed fox',
  // Characters & archetypes — polished versions
  'a robot head',
  'an astronaut helmet',
  'a samurai helmet',
  'a chess king piece',
  'a knight in armor',
  'a space explorer',
  'a scholar with books',
  'a captain at the helm',
  // Symbols & objects — elegant
  'a diamond',
  'a crown',
  'an hourglass',
  'a crystal ball',
  'a compass rose',
  'a crescent moon',
  'a lightning bolt',
  'a glowing lantern',
  'a golden coin',
  'a key',
  // Abstract
  'a fractal flower',
  'a DNA helix',
  'a geometric eye',
  'a spiral galaxy',
  'a lotus flower',
];

// ── Backgrounds ──────────────────────────────────────────────────────
const BACKGROUNDS = [
  // Abstract & pattern
  'a soft geometric gradient',
  'concentric circles in muted tones',
  'a mandala pattern',
  'liquid marble in deep blue and gold',
  'a topographic map in sepia',
  'a clean studio gradient',
  // Color fields
  'a deep midnight blue',
  'a rich forest green',
  'a warm amber and gold gradient',
  'a dark charcoal with soft glow',
  'a pastel watercolor wash',
  'a muted earth tone palette',
  'an iridescent sheen',
  'a stark white minimalist backdrop',
  'a deep navy with stars',
  // Environments
  'a dense jungle canopy',
  'an underwater coral reef',
  'a mountain range at dusk',
  'a snowy mountain peak',
  'a desert with dunes',
  'outer space with nebulae',
  'an ancient temple interior',
  'a field of wildflowers',
  'a serene lake at dawn',
  'a bamboo forest in mist',
];

// ── Themes / moods — polished and appealing ──────────────────────────
const THEMES = [
  'elegant and regal',
  'ethereal and dreamlike',
  'serene and zen',
  'bold and powerful',
  'ancient and mystical',
  'minimalist and clean',
  'cosmic and celestial',
  'warm and inviting',
  'cool and focused',
  'vibrant and energetic',
  'mysterious and atmospheric',
  'crisp and modern',
  'rich and luxurious',
  'playful and whimsical',
  'sharp and cinematic',
  'soft and peaceful',
  'heroic and epic',
  'enchanted fairy tale',
  'lo-fi chill',
  'sophisticated and refined',
];

// ── Art styles — polished, not meme-y ────────────────────────────────
export const STYLES = [
  '3D Pixar render',
  'hand-drawn ink illustration',
  'digital concept art',
  'anime illustration',
  'oil painting',
  'watercolor painting',
  'low poly 3D',
  'comic book illustration',
  'woodblock print',
  'stained glass illustration',
  'ukiyo-e Japanese art',
  'art nouveau poster',
  'claymation style',
  'pencil graphite sketch',
  'vector flat design',
  'impressionist painting',
  'cel-shaded cartoon',
  'matte painting',
  'studio photography',
  'linocut print',
  'bold graphic design',
  'fantasy concept art',
  'character design sheet',
  'luminous digital painting',
  'soft pastel illustration',
];

// ── Prompt builder ───────────────────────────────────────────────────
interface PfpSpec {
  index: number;
  subject: string;
  background: string;
  theme: string;
  style: string;
  prompt: string;
}

export function buildPrompt(
  subject: string,
  background: string,
  theme: string,
  style: string
): string {
  return `A polished profile picture avatar: ${subject}, ${theme} mood, rendered in ${style} style. Background: ${background}. Centered composition, close-up portrait framing, square crop. High quality, clean edges, no text, no watermarks, no logos.`;
}

// ── Deterministic shuffle ────────────────────────────────────────────
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
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Generate 150 unique combos ──────────────────────────────────────
function generateSpecs(): PfpSpec[] {
  const rand = seededRandom(777);
  const specs: PfpSpec[] = [];
  const seen = new Set<string>();

  const subjects = shuffle(SUBJECTS, rand);
  const backgrounds = shuffle(BACKGROUNDS, rand);
  const themes = shuffle(THEMES, rand);
  const styles = shuffle(STYLES, rand);

  let si = 0,
    bi = 0,
    ti = 0,
    sti = 0;

  while (specs.length < 150) {
    const subject = subjects[si % subjects.length]!;
    const background = backgrounds[bi % backgrounds.length]!;
    const theme = themes[ti % themes.length]!;
    const style = styles[sti % styles.length]!;

    const key = `${subject}|${background}|${theme}|${style}`;
    if (!seen.has(key)) {
      seen.add(key);
      specs.push({
        index: specs.length,
        subject,
        background,
        theme,
        style,
        prompt: buildPrompt(subject, background, theme, style),
      });
    }

    si++;
    bi += 3;
    ti += 7;
    sti += 11;
  }

  return specs;
}

// ── Main ─────────────────────────────────────────────────────────────
const CONCURRENCY = 20;
const TIMEOUT_MS = 120_000;
const OUTPUT_DIR = join(import.meta.dir, '..', 'output', 'user-pfps');

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

function slugify(s: string): string {
  return s
    .replace(/^an?\s+/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

async function generateImage(spec: PfpSpec): Promise<void> {
  const filename = `${String(spec.index).padStart(3, '0')}_${slugify(spec.subject)}_${slugify(spec.style)}.png`;
  const outPath = join(OUTPUT_DIR, filename);

  if (existsSync(outPath)) {
    console.log(`[${spec.index + 1}/150] Skipping (exists): ${filename}`);
    return;
  }

  console.log(
    `[${spec.index + 1}/150] ${spec.subject} / ${spec.style} / ${spec.theme}`
  );

  try {
    const result = await withTimeout(
      fal.subscribe('fal-ai/nano-banana-2', {
        input: {
          prompt: spec.prompt,
          num_images: 1,
          resolution: '1K',
          aspect_ratio: '1:1',
          output_format: 'png',
          limit_generations: true,
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === 'IN_PROGRESS') {
            update.logs
              ?.map((log) => log.message)
              .forEach((m) => console.log(`  [queue] ${m}`));
          }
        },
      }),
      TIMEOUT_MS,
      filename
    );

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
      `  ✗ Failed ${filename}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function main() {
  const specs = generateSpecs();

  if (process.argv.includes('--dry-run')) {
    console.log('=== DRY RUN: 150 User PFP Specs ===\n');
    for (const spec of specs) {
      console.log(
        `${String(spec.index + 1).padStart(3, ' ')}. ${spec.subject} | ${spec.style} | ${spec.theme} | ${spec.background}`
      );
    }

    const dist = (key: keyof PfpSpec) => {
      const counts: Record<string, number> = {};
      for (const s of specs)
        counts[s[key] as string] = (counts[s[key] as string] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    };

    for (const [label, key] of [
      ['Style', 'style'],
      ['Theme', 'theme'],
      ['Subject', 'subject'],
    ] as const) {
      console.log(`\n--- ${label} distribution ---`);
      for (const [val, count] of dist(key)) {
        console.log(`  ${val}: ${count}`);
      }
    }
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(
    `Generating 150 user profile pictures (concurrency: ${CONCURRENCY})...\n`
  );

  for (let i = 0; i < specs.length; i += CONCURRENCY) {
    const batch = specs.slice(i, i + CONCURRENCY);
    console.log(
      `\n── Batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(specs.length / CONCURRENCY)} ──`
    );
    await Promise.all(batch.map(generateImage));
  }

  const generated = specs.filter((s) => {
    const fn = `${String(s.index).padStart(3, '0')}_${slugify(s.subject)}_${slugify(s.style)}.png`;
    return existsSync(join(OUTPUT_DIR, fn));
  }).length;

  console.log(`\n✓ Done! ${generated}/150 user PFPs generated.`);
  if (generated < 150) {
    console.log(
      '  Re-run the script to retry failed ones (skip-existing is on).'
    );
  }
}

main().catch(console.error);
