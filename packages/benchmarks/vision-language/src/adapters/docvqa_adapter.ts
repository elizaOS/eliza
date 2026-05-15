/**
 * DocVQA adapter.
 *
 * Benchmark: DocVQA — VQA over document images (forms, invoices, reports).
 *
 * Paper:   Mathew et al. 2021, "DocVQA: A Dataset for VQA on Document Images"
 *          (https://arxiv.org/abs/2007.00398).
 * Dataset: https://www.docvqa.org/ — research-only license, requires
 *          registration. The val split is ≈1.3 GB. Full eval expects
 *          `DOCVQA_DATA_DIR` pointing at the standard layout
 *          (`val/val_v1.0_withQT.json`, `documents/`).
 *
 * Sample shape: { id, imagePath, question, payload: { answers: string[] } }
 *
 * Scoring: ANLS (Average Normalized Levenshtein Similarity) with τ = 0.5,
 * the official DocVQA metric.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anls } from "../scorers/index.ts";
import type {
  BenchmarkAdapter,
  Prediction,
  Sample,
  VisionRuntime,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export interface DocVqaPayload {
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
  questionId: number;
  question: string;
  image: string;
  answers: string[];
}

export class DocVqaAdapter implements BenchmarkAdapter<DocVqaPayload> {
  readonly name = "docvqa" as const;

  async loadSamples(
    n: number,
    opts: { smoke: boolean },
  ): Promise<Sample<DocVqaPayload>[]> {
    if (opts.smoke) return loadSmoke(n);
    return loadOfficial(n);
  }

  scoreOne(sample: Sample<DocVqaPayload>, prediction: Prediction) {
    const text = prediction.text ?? "";
    const score = anls(text, sample.payload.answers);
    return {
      score,
      detail: {
        prediction: text,
        anls: score,
      },
    };
  }
}

export async function predictDocVqa(
  runtime: VisionRuntime,
  samples: Sample<DocVqaPayload>[],
): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const sample of samples) {
    const startedAt = Date.now();
    try {
      const text = await runtime.ask({
        imagePath: sample.imagePath,
        question: sample.question,
        maxTokens: 64,
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

function loadSmoke(n: number): Sample<DocVqaPayload>[] {
  const file = path.join(PACKAGE_ROOT, "samples", "docvqa", "smoke.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as SmokeFile;
  return raw.samples.slice(0, n).map((s) => ({
    id: s.id,
    imagePath: path.join(PACKAGE_ROOT, s.imagePath),
    question: s.question,
    payload: { answers: s.answers },
  }));
}

function loadOfficial(n: number): Sample<DocVqaPayload>[] {
  const dir = process.env.DOCVQA_DATA_DIR;
  if (!dir) {
    throw new Error(
      "DOCVQA_DATA_DIR is not set. Point it at a local DocVQA mirror " +
        "with `val/val_v1.0_withQT.json` and `documents/`, or pass --smoke.",
    );
  }
  const annPath = path.join(dir, "val_v1.0_withQT.json");
  if (!existsSync(annPath)) {
    throw new Error(
      `DocVQA validation annotations not found at ${annPath}. ` +
        "Register at https://www.docvqa.org/ to download.",
    );
  }
  const raw = JSON.parse(readFileSync(annPath, "utf8")) as {
    data: OfficialAnnotation[];
  };
  return raw.data.slice(0, n).map((entry) => ({
    id: String(entry.questionId),
    imagePath: path.join(dir, "documents", entry.image),
    question: entry.question,
    payload: { answers: entry.answers },
  }));
}
