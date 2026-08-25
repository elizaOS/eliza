/**
 * Downloads the CC BY 4.0 LoSoNA corpus and deterministically emits one
 * scenario per accepted row. The generator preserves every visible transcript
 * turn and withholds only the evaluation-only hidden norm fields.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupChatCorpusError } from "../_errors.ts";

const SOURCE_REVISION = "88d0846588c967e990157de06477595224f427da";
const SOURCE_SHA256 =
  "3f7712f8f97d8e97362e4eee80f333283bb5530cae065a7f8c9a5c35832d8540";
const SOURCE_URL = `https://huggingface.co/datasets/Humalike-ai/LoSoNA/resolve/${SOURCE_REVISION}/data/losona_scenarios.jsonl`;
const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(
  tmpdir(),
  "eliza-group-chat-eval",
  `losona_scenarios-${SOURCE_REVISION}.jsonl`,
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
    throw groupChatCorpusError({
      code: "LOSONA_INVALID_SOURCE_ROW",
      message: "LoSoNA source line is not an object",
      context: { line: lineNumber },
    });
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
    throw groupChatCorpusError({
      code: "LOSONA_INVALID_SOURCE_ROW",
      message: "LoSoNA source line has an unsupported schema",
      context: { line: lineNumber },
    });
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

export function verifyLoSoNASource(text: string): string {
  const actual = createHash("sha256").update(text).digest("hex");
  if (actual !== SOURCE_SHA256) {
    throw groupChatCorpusError({
      code: "LOSONA_SOURCE_HASH_MISMATCH",
      message: "LoSoNA source digest does not match the pin",
      context: { expected: SOURCE_SHA256, actual, revision: SOURCE_REVISION },
    });
  }
  return text;
}

async function sourceText(): Promise<string> {
  if (existsSync(CACHE_PATH)) {
    return verifyLoSoNASource(await readFile(CACHE_PATH, "utf8"));
  }
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw groupChatCorpusError({
      code: "LOSONA_SOURCE_FETCH_FAILED",
      message: "LoSoNA source request failed",
      context: { url: SOURCE_URL, status: response.status },
    });
  }
  const text = verifyLoSoNASource(await response.text());
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, text);
  return text;
}

function slug(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function render(row: LoSoNARow, index: number): string {
  const elicitor = row.transcript.find(
    (turn) => turn.turn_id === row.elicitor_turn_id && turn.is_elicitor,
  );
  if (!elicitor) {
    throw groupChatCorpusError({
      code: "LOSONA_MISSING_ELICITOR",
      message: "LoSoNA row has no matching elicitor",
      context: { scenarioId: row.scenario_id },
    });
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
  return `/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run \`bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts\`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  buildNormProbeSetup,
  type NormProbeConfig,
} from "./_factory.ts";

const config = ${JSON.stringify(config, null, 2)} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: ${JSON.stringify(config.id)},
  title: ${JSON.stringify(config.title)},
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.messageTurn,
      assertResponse(text: string) {
        if (text.trim().length === 0) {
          return "the elicitor requires a group-chat reply that demonstrates the inferred norm";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "local-norm-adoption",
      minimumScore: 0.8,
      rubric:
        \`Judge only the subject agent's reply to the final elicitor. The group's hidden local norm is: \${config.hiddenNorm}\` +
        " The target norm must be inferred only from peer demonstrations in the visible transcript. Score 1.0 only if the reply follows the functional norm naturally in the current context. Mere discussion or naming of the norm does not count. Score 0.0 if it violates the norm or responds as a generic assistant instead of a group member.",
    },
  ],
});
`;
}

async function main(): Promise<void> {
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
        throw groupChatCorpusError({
          code: "LOSONA_INVALID_JSON",
          message: "LoSoNA source line is invalid JSON",
          context: { line: index + 1 },
          cause,
        });
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
  if (format.status !== 0)
    throw groupChatCorpusError({
      code: "LOSONA_FORMAT_FAILED",
      message: "Failed to format generated LoSoNA scenarios",
      context: { outputDir: OUT_DIR, exitCode: format.status },
      cause: format.error,
    });

  console.info(`Generated ${rows.length} LoSoNA scenarios in ${OUT_DIR}`);
}

if (import.meta.main) await main();
