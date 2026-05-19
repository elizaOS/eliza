/**
 * TextVQA adapter.
 *
 * Benchmark: TextVQA — visual question answering that requires reading
 * scene text in the image.
 *
 * Paper:   Singh et al. 2019, "Towards VQA Models That Can Read"
 *          (https://arxiv.org/abs/1904.08920).
 * Dataset: https://textvqa.org/dataset/ — Apache-2.0 annotations,
 *          Open Images CC-BY images. Full eval downloads ≈6.6 GB. Not
 *          fetched here; the runner expects `TEXTVQA_DATA_DIR` to point
 *          at a local mirror with the standard `train/val` JSON layout.
 *
 * Sample shape: { id, imagePath, question, payload: { answers: string[] } }
 *
 * Scoring: VQA soft-score (`min(matches/3, 1)`) over the 10 reference
 * answers. We also expose the binary exact-match for leaderboard parity.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactMatch, vqaSoftScore } from "../scorers/index.ts";
import type {
  BenchmarkAdapter,
  Prediction,
  Sample,
  VisionRuntime,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export interface TextVqaPayload {
  answers: string[];
}

interface SmokeFile {
  samples: Array<{
    id: string;
    imagePath: string;
    question: string;
    answers: string[];
  }>;
}

interface OfficialAnnotation {
  question_id: number | string;
  question: string;
  image_id: string;
  flickr_original_url?: string;
  flickr_300k_url?: string;
  answers: string[];
}

export class TextVqaAdapter implements BenchmarkAdapter<TextVqaPayload> {
  readonly name = "textvqa" as const;

  async loadSamples(
    n: number,
    opts: { smoke: boolean },
  ): Promise<Sample<TextVqaPayload>[]> {
    if (opts.smoke) return loadSmoke(n);
    return loadOfficial(n);
  }

  scoreOne(sample: Sample<TextVqaPayload>, prediction: Prediction) {
    const text = prediction.text ?? "";
    const soft = vqaSoftScore(text, sample.payload.answers);
    return {
      score: soft,
      detail: {
        prediction: text,
        exactMatch: exactMatch(text, sample.payload.answers),
      },
    };
  }
}

/**
 * Driver: ask the runtime each question and assemble Prediction objects.
 * Exposed so the runner can call into one helper per adapter without
 * needing to know which model entrypoint each adapter uses.
 */
export async function predictTextVqa(
  runtime: VisionRuntime,
  samples: Sample<TextVqaPayload>[],
): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const sample of samples) {
    const startedAt = Date.now();
    try {
      const text = await runtime.ask({
        imagePath: sample.imagePath,
        question: sample.question,
        maxTokens: 32,
      });
      out.push({ text, latencyMs: Date.now() - startedAt });
    } catch (err) {
      out.push({
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function loadSmoke(n: number): Sample<TextVqaPayload>[] {
  const file = path.join(PACKAGE_ROOT, "samples", "textvqa", "smoke.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as SmokeFile;
  return raw.samples.slice(0, n).map((s) => ({
    id: s.id,
    imagePath: path.join(PACKAGE_ROOT, s.imagePath),
    question: s.question,
    payload: { answers: s.answers },
  }));
}

async function loadOfficial(n: number): Promise<Sample<TextVqaPayload>[]> {
  const dir = process.env.TEXTVQA_DATA_DIR;
  if (!dir) return loadHfTextVqa(n);
  const annPath = path.join(dir, "TextVQA_0.5.1_val.json");
  if (!existsSync(annPath)) {
    throw new Error(
      `TextVQA validation annotations not found at ${annPath}. ` +
        "See https://textvqa.org/dataset/ for download instructions.",
    );
  }
  const raw = JSON.parse(readFileSync(annPath, "utf8")) as {
    data: OfficialAnnotation[];
  };
  return raw.data.slice(0, n).map((entry) => ({
    id: String(entry.question_id),
    imagePath: path.join(dir, "train_images", `${entry.image_id}.jpg`),
    question: entry.question,
    payload: { answers: entry.answers },
  }));
}

async function loadHfTextVqa(n: number): Promise<Sample<TextVqaPayload>[]> {
  const annotationUrl =
    process.env.TEXTVQA_HF_ANNOTATION_URL ||
    "https://huggingface.co/datasets/redactable-llm/TextVQA/resolve/main/TextVQA_0.5.1_val.json";
  const response = await fetch(annotationUrl);
  if (!response.ok) {
    throw new Error(
      `failed to download TextVQA annotations (${response.status}): ${annotationUrl}`,
    );
  }
  const raw = (await response.json()) as { data: OfficialAnnotation[] };
  const cacheDir = path.join(PACKAGE_ROOT, "samples", ".cache", "textvqa-hf");
  mkdirSync(cacheDir, { recursive: true });
  const samples: Sample<TextVqaPayload>[] = [];
  for (const entry of raw.data) {
    if (samples.length >= n) break;
    const url = entry.flickr_300k_url || entry.flickr_original_url;
    if (!url) continue;
    try {
      const imagePath = await downloadImage(url, cacheDir, entry.image_id);
      samples.push({
        id: String(entry.question_id),
        imagePath,
        question: entry.question,
        payload: { answers: entry.answers },
      });
    } catch {
      // Some original Flickr URLs disappear over time; keep walking the real
      // annotation set until we have the requested number of downloadable rows.
    }
  }
  if (samples.length === 0) {
    throw new Error(
      "TextVQA HF annotations loaded, but no image URLs were downloadable",
    );
  }
  return samples;
}

async function downloadImage(
  url: string,
  cacheDir: string,
  imageId: string,
): Promise<string> {
  const ext = path.extname(new URL(url).pathname) || ".jpg";
  const target = path.join(cacheDir, `${imageId}${ext}`);
  if (existsSync(target)) return target;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download TextVQA image ${imageId}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`empty TextVQA image ${imageId}`);
  }
  writeFileSync(target, bytes);
  return target;
}
