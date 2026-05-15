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
import { existsSync, readFileSync } from "node:fs";
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

function loadOfficial(n: number): Sample<TextVqaPayload>[] {
  const dir = process.env.TEXTVQA_DATA_DIR;
  if (!dir) {
    throw new Error(
      "TEXTVQA_DATA_DIR is not set. Point it at a local TextVQA mirror " +
        "with `val/TextVQA_0.5.1_val.json` and `images/`, or pass --smoke.",
    );
  }
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
