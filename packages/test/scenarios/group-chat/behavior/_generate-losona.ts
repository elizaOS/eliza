/**
 * Downloads the CC BY 4.0 LoSoNA corpus and deterministically emits one
 * scenario per accepted row. The generator preserves every visible transcript
 * turn and withholds only the evaluation-only hidden norm fields.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://huggingface.co/datasets/Humalike-ai/LoSoNA/resolve/main/data/losona_scenarios.jsonl";
const SOURCE_REVISION = "main as retrieved 2026-08-23";
const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(
  tmpdir(),
  "eliza-group-chat-eval",
  "losona_scenarios.jsonl",
);

type LoSoNATurn = {
  turn_id: number;
  actor: string;
  content: string;
  is_elicitor: boolean;
};

type LoSoNARow = {
  scenario_id: string;
  event_id: string;
  norm_id: string;
  norm_statement: string;
  transcript: LoSoNATurn[];
  elicitor_turn_id: number;
};

function isTurn(value: unknown): value is LoSoNATurn {
  if (!value || typeof value !== "object") return false;
  return (
    "turn_id" in value &&
    typeof value.turn_id === "number" &&
    "actor" in value &&
    typeof value.actor === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "is_elicitor" in value &&
    typeof value.is_elicitor === "boolean"
  );
}

function parseRow(value: unknown, lineNumber: number): LoSoNARow {
  if (!value || typeof value !== "object") {
    throw new Error(`LoSoNA line ${lineNumber} is not an object`);
  }
  const fields = value;
  if (
    !("scenario_id" in fields) ||
    typeof fields.scenario_id !== "string" ||
    !("event_id" in fields) ||
    typeof fields.event_id !== "string" ||
    !("norm_id" in fields) ||
    typeof fields.norm_id !== "string" ||
    !("norm_statement" in fields) ||
    typeof fields.norm_statement !== "string" ||
    !("elicitor_turn_id" in fields) ||
    typeof fields.elicitor_turn_id !== "number" ||
    !("transcript" in fields) ||
    !Array.isArray(fields.transcript) ||
    !fields.transcript.every(isTurn)
  ) {
    throw new Error(`LoSoNA line ${lineNumber} has an unsupported schema`);
  }
  return {
    scenario_id: fields.scenario_id,
    event_id: fields.event_id,
    norm_id: fields.norm_id,
    norm_statement: fields.norm_statement,
    transcript: fields.transcript,
    elicitor_turn_id: fields.elicitor_turn_id,
  };
}

async function sourceText(): Promise<string> {
  try {
    return await readFile(CACHE_PATH, "utf8");
  } catch {
    // error-policy:J2 Cache absence adds fetch context and preserves the cause.
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(
        `LoSoNA download failed with HTTP ${response.status} from ${SOURCE_URL}`,
      );
    }
    const text = await response.text();
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, text);
    return text;
  }
}

function slug(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function render(row: LoSoNARow, index: number): string {
  const elicitor = row.transcript.find(
    (turn) => turn.turn_id === row.elicitor_turn_id && turn.is_elicitor,
  );
  if (!elicitor) {
    throw new Error(`LoSoNA row ${row.scenario_id} has no matching elicitor`);
  }
  const context = row.transcript
    .filter((turn) => turn.turn_id !== row.elicitor_turn_id)
    .map((turn) => ({ speaker: turn.actor, text: turn.content }));
  const config = {
    id: `groupchat.behavior.losona.${slug(index)}`,
    title: `Local norm adoption: ${row.event_id.replaceAll("_", " ")}`,
    source: "losona",
    sourceCase: `LoSoNA ${row.scenario_id}, ${SOURCE_REVISION}, CC BY 4.0`,
    context,
    elicitor: { speaker: elicitor.actor, text: elicitor.content },
    hiddenNorm: row.norm_statement,
  };
  return `/**\n * Generated from Humalike-ai/LoSoNA (CC BY 4.0).\n * Do not hand-edit; run \`bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts\`.\n */\nimport { buildNormProbe } from "./_factory.ts";\n\nexport default buildNormProbe(${JSON.stringify(config, null, 2)});\n`;
}

const text = await sourceText();
const rows = text
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      // error-policy:J2 Malformed source data fails generation with its row.
      throw new Error(`LoSoNA line ${index + 1} is invalid JSON`, { cause });
    }
    return parseRow(parsed, index + 1);
  })
  .sort((left, right) => left.scenario_id.localeCompare(right.scenario_id));

for (const entry of await readdir(OUT_DIR)) {
  if (
    entry.startsWith("groupchat.behavior.losona.") &&
    entry.endsWith(".scenario.ts")
  ) {
    await rm(join(OUT_DIR, entry));
  }
}
await Promise.all(
  rows.map((row, index) =>
    writeFile(
      join(OUT_DIR, `groupchat.behavior.losona.${slug(index)}.scenario.ts`),
      render(row, index),
    ),
  ),
);

const format = spawnSync(
  "bunx",
  ["@biomejs/biome", "format", "--write", OUT_DIR],
  { cwd: join(OUT_DIR, "../../../../.."), stdio: "inherit" },
);
if (format.status !== 0) {
  throw new Error(`Biome formatting failed with status ${format.status}`);
}

console.info(`Generated ${rows.length} LoSoNA scenarios in ${OUT_DIR}`);
