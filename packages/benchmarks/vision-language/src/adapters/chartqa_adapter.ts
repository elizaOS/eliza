/**
 * ChartQA adapter.
 *
 * Benchmark: ChartQA — VQA over bar/line/pie charts requiring numeric and
 * compositional reasoning.
 *
 * Paper:   Masry et al. 2022, "ChartQA: A Benchmark for Question Answering
 *          about Charts with Visual and Logical Reasoning"
 *          (https://aclanthology.org/2022.findings-acl.177/).
 * Dataset: https://github.com/vis-nlp/ChartQA — GPL-3.0 annotations + images.
 *          Full eval expects `CHARTQA_DATA_DIR` pointing at the cloned repo
 *          with `ChartQA Dataset/test/test_human.json` + `test_augmented.json`
 *          and `png/`.
 *
 * Sample shape: { id, imagePath, question,
 *   payload: { answers: string[]; answerType: "numeric" | "categorical" } }
 *
 * Scoring: relaxed numeric correctness (±5%) for numeric answers, normalised
 * exact-match for categorical answers.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relaxedNumeric } from "../scorers/index.ts";
import type {
  BenchmarkAdapter,
  Prediction,
  Sample,
  VisionRuntime,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export interface ChartQaPayload {
  answers: string[];
  answerType: "numeric" | "categorical";
}

interface SmokeFile {
  samples: Array<{
    id: string;
    imagePath: string;
    question: string;
    answers: string[];
    answerType: "numeric" | "categorical";
  }>;
}

interface OfficialAnnotation {
  imgname: string;
  query: string;
  label: string;
  answer_type?: "numeric" | "categorical";
}

export class ChartQaAdapter implements BenchmarkAdapter<ChartQaPayload> {
  readonly name = "chartqa" as const;

  async loadSamples(
    n: number,
    opts: { smoke: boolean },
  ): Promise<Sample<ChartQaPayload>[]> {
    if (opts.smoke) return loadSmoke(n);
    return loadOfficial(n);
  }

  scoreOne(sample: Sample<ChartQaPayload>, prediction: Prediction) {
    const text = prediction.text ?? "";
    const score = relaxedNumeric(text, sample.payload.answers);
    return {
      score,
      detail: {
        prediction: text,
        answerType: sample.payload.answerType,
      },
    };
  }
}

export async function predictChartQa(
  runtime: VisionRuntime,
  samples: Sample<ChartQaPayload>[],
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

function loadSmoke(n: number): Sample<ChartQaPayload>[] {
  const file = path.join(PACKAGE_ROOT, "samples", "chartqa", "smoke.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as SmokeFile;
  return raw.samples.slice(0, n).map((s) => ({
    id: s.id,
    imagePath: path.join(PACKAGE_ROOT, s.imagePath),
    question: s.question,
    payload: { answers: s.answers, answerType: s.answerType },
  }));
}

function loadOfficial(n: number): Sample<ChartQaPayload>[] {
  const dir = process.env.CHARTQA_DATA_DIR;
  if (!dir) {
    throw new Error(
      "CHARTQA_DATA_DIR is not set. Point it at a local ChartQA checkout " +
        "with `ChartQA Dataset/test/test_human.json` and `png/`, or pass --smoke.",
    );
  }
  const annPath = path.join(dir, "test", "test_human.json");
  if (!existsSync(annPath)) {
    throw new Error(
      `ChartQA test annotations not found at ${annPath}. ` +
        "See https://github.com/vis-nlp/ChartQA for layout.",
    );
  }
  const raw = JSON.parse(readFileSync(annPath, "utf8")) as OfficialAnnotation[];
  return raw.slice(0, n).map((entry, i) => ({
    id: `chartqa-test-${i}`,
    imagePath: path.join(dir, "png", entry.imgname),
    question: entry.query,
    payload: {
      answers: [entry.label],
      answerType:
        entry.answer_type ??
        (Number.isFinite(Number.parseFloat(entry.label))
          ? "numeric"
          : "categorical"),
    },
  }));
}
