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
  const configuredDir = process.env.CHARTQA_DATA_DIR;
  if (!configuredDir) {
    throw new Error(
      "CHARTQA_DATA_DIR is not set. Point it at a local ChartQA checkout " +
        "with both test annotation files and `png/`, or pass --smoke.",
    );
  }
  const roots = [configuredDir, path.join(configuredDir, "ChartQA Dataset")];
  const dir = roots.find(
    (candidate) =>
      existsSync(path.join(candidate, "test", "test_human.json")) &&
      existsSync(path.join(candidate, "test", "test_augmented.json")),
  );
  if (!dir) {
    throw new Error(
      `ChartQA requires both test_human.json and test_augmented.json under ${configuredDir}. ` +
        "See https://github.com/vis-nlp/ChartQA for the canonical layout.",
    );
  }
  const human = readAnnotations(path.join(dir, "test", "test_human.json"));
  const augmented = readAnnotations(
    path.join(dir, "test", "test_augmented.json"),
  );
  const rows: Array<{
    split: "human" | "augmented";
    entry: OfficialAnnotation;
  }> = [];
  const maxLength = Math.max(human.length, augmented.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (human[index]) rows.push({ split: "human", entry: human[index] });
    if (augmented[index]) {
      rows.push({ split: "augmented", entry: augmented[index] });
    }
  }
  return rows.slice(0, n).map(({ split, entry }, index) => ({
    id: `chartqa-test-${split}-${index}`,
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

function readAnnotations(file: string): OfficialAnnotation[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`ChartQA annotation file is not an array: ${file}`);
  }
  return parsed as OfficialAnnotation[];
}
