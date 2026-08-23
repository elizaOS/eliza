/**
 * Reproduces a balanced held-out scenario sample from the three test splits of
 * ishiki-labs/multi-party-dialogue. The generator pins the source revision,
 * validates every selected row, preserves every supplied context turn, and
 * records the source decision id in each generated scenario.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const ISHIKI_REVISION = "356c30b9dc74cbfa115ab7b9a89991d92ce0a315";
const DATASET = "ishiki-labs/multi-party-dialogue";
const DOMAINS = ["ami", "friends", "spgi"] as const;
const SOURCE_SHA256 = {
  ami: "bc770473c45277223445b8ca05f751c9a4b6c53195e37356c46ba5ff9f839c93",
  friends: "21df2d2d6f4126a43153ac054f731b742295d1b7d2bd700aa890303f6fae2c50",
  spgi: "862cdaa26aadbf3535352f31191ea9266dd7523b84f313affb24e34c28740e6b",
} satisfies Record<(typeof DOMAINS)[number], string>;
const PER_DOMAIN_LABEL = 4;
const CACHE_DIR = path.join(tmpdir(), "eliza-group-chat-eval", "ishiki");
const OUTPUT_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "ishiki",
);

type Domain = (typeof DOMAINS)[number];
type Turn = { speaker: string; text: string };
const AGENT_NAME = "ScenarioAgent";
export type IshikiPoint = {
  decisionPointId: string;
  targetSpeaker: string;
  context: Turn[];
  decisionTurn: Turn;
  label: "speak" | "silent";
  directlyAddressed: boolean;
  sourceDomain: Domain;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTurn(value: unknown, field: string): Turn {
  if (
    !isRecord(value) ||
    typeof value.speaker !== "string" ||
    typeof value.text !== "string"
  ) {
    throw new Error(
      `[ishiki] ${field} must contain string speaker and text fields`,
    );
  }
  if (!value.speaker.trim() || !value.text.trim()) {
    throw new Error(`[ishiki] ${field} contains an empty speaker or text`);
  }
  return { speaker: value.speaker, text: value.text };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function occupyTargetSeat(turn: Turn, targetSpeaker: string): Turn {
  const targetPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(targetSpeaker)}(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return {
    speaker: turn.speaker === targetSpeaker ? AGENT_NAME : turn.speaker,
    text: turn.text.replace(targetPattern, AGENT_NAME),
  };
}

export function parseIshikiRow(
  value: unknown,
  sourceDomain: Domain,
): IshikiPoint {
  if (!isRecord(value)) throw new Error("[ishiki] row must be an object");
  if (typeof value.decision_point_id !== "string") {
    throw new Error("[ishiki] row has no decision_point_id");
  }
  if (typeof value.target_speaker !== "string") {
    throw new Error(
      `[ishiki] ${value.decision_point_id} has no target_speaker`,
    );
  }
  if (!Array.isArray(value.context_turns)) {
    throw new Error(
      `[ishiki] ${value.decision_point_id} has no context_turns array`,
    );
  }
  if (value.decision !== "SPEAK" && value.decision !== "SILENT") {
    throw new Error(`[ishiki] ${value.decision_point_id} has invalid decision`);
  }
  if (typeof value.target_is_addressed !== "boolean") {
    throw new Error(
      `[ishiki] ${value.decision_point_id} has invalid target_is_addressed`,
    );
  }
  const targetSpeaker = value.target_speaker;
  return {
    decisionPointId: value.decision_point_id,
    targetSpeaker,
    context: value.context_turns.map((turn, index) =>
      occupyTargetSeat(
        parseTurn(turn, `context_turns[${index}]`),
        targetSpeaker,
      ),
    ),
    decisionTurn: occupyTargetSeat(
      parseTurn(value.current_turn, "current_turn"),
      targetSpeaker,
    ),
    label: value.decision === "SPEAK" ? "speak" : "silent",
    directlyAddressed: value.target_is_addressed,
    sourceDomain,
  };
}

function stableRank(point: IshikiPoint): string {
  return createHash("sha256")
    .update(`${ISHIKI_REVISION}:${point.sourceDomain}:${point.decisionPointId}`)
    .digest("hex");
}

export function selectIshikiPoints(points: IshikiPoint[]): IshikiPoint[] {
  const selected: IshikiPoint[] = [];
  for (const domain of DOMAINS) {
    for (const label of ["speak", "silent"] as const) {
      const cell = points
        .filter(
          (point) =>
            point.sourceDomain === domain &&
            point.label === label &&
            point.context.length > 0,
        )
        .sort((left, right) =>
          stableRank(left).localeCompare(stableRank(right)),
        )
        .slice(0, PER_DOMAIN_LABEL);
      if (cell.length !== PER_DOMAIN_LABEL) {
        throw new Error(
          `[ishiki] ${domain}/${label} has ${cell.length} usable rows, expected ${PER_DOMAIN_LABEL}`,
        );
      }
      selected.push(...cell);
    }
  }
  return selected;
}

async function fetchDomain(domain: Domain): Promise<string> {
  const cacheFile = path.join(
    CACHE_DIR,
    `${domain}-test-${ISHIKI_REVISION}.jsonl`,
  );
  try {
    return await readFile(cacheFile, "utf8");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
    // error-policy:J2 the cache miss is the only recoverable read failure.
  }
  await mkdir(CACHE_DIR, { recursive: true });
  const url = `https://huggingface.co/datasets/${DATASET}/resolve/${ISHIKI_REVISION}/${domain}/test/test_samples.jsonl`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`[ishiki] ${url} returned ${response.status}`);
  const body = await response.text();
  await writeFile(cacheFile, body, "utf8");
  return body;
}

function verifySource(domain: Domain, raw: string): string {
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== SOURCE_SHA256[domain]) {
    throw new Error(
      `[ishiki] ${domain} source hash mismatch: expected ${SOURCE_SHA256[domain]}, got ${actual}`,
    );
  }
  return actual;
}

function renderScenario(
  point: IshikiPoint,
  ordinal: number,
): { fileName: string; source: string } {
  const id = `groupchat.ishiki.${point.sourceDomain}.${point.label}.${String(ordinal).padStart(3, "0")}`;
  const config = {
    id,
    title: `Held-out group timing: ${point.sourceDomain.toUpperCase()} ${point.label.toUpperCase()}`,
    label: point.label,
    directlyAddressed: point.directlyAddressed,
    targetSpeaker: point.targetSpeaker,
    context: point.context,
    decisionTurn: point.decisionTurn,
    sourceDomain: point.sourceDomain,
    sourceDecisionPointId: point.decisionPointId,
    sourceRevision: ISHIKI_REVISION,
  };
  return {
    fileName: `${id}.scenario.ts`,
    source: `/**\n * Generated from ishiki-labs/multi-party-dialogue at ${ISHIKI_REVISION}.\n * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.\n */\nimport { buildHeldoutScenario } from "../_factory.ts";\n\nexport default buildHeldoutScenario(${JSON.stringify(config, null, 2)});\n`,
  };
}

export async function generateIshikiScenarios(): Promise<void> {
  const points: IshikiPoint[] = [];
  const sourceFiles: Array<{ domain: Domain; sha256: string }> = [];
  for (const domain of DOMAINS) {
    const raw = await fetchDomain(domain);
    sourceFiles.push({ domain, sha256: verifySource(domain, raw) });
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `[ishiki] ${domain} line ${index + 1} is invalid JSON`,
          { cause: error },
        );
      }
      points.push(parseIshikiRow(decoded, domain));
    }
  }
  const selected = selectIshikiPoints(points);
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const entry of await readdir(OUTPUT_DIR)) {
    if (entry.endsWith(".scenario.ts"))
      await unlink(path.join(OUTPUT_DIR, entry));
  }
  const ordinals = new Map<string, number>();
  const trace: Array<{
    id: string;
    decisionPointId: string;
    domain: Domain;
    label: string;
  }> = [];
  for (const point of selected) {
    const cell = `${point.sourceDomain}:${point.label}`;
    const ordinal = (ordinals.get(cell) ?? 0) + 1;
    ordinals.set(cell, ordinal);
    const rendered = renderScenario(point, ordinal);
    await writeFile(
      path.join(OUTPUT_DIR, rendered.fileName),
      rendered.source,
      "utf8",
    );
    trace.push({
      id: rendered.fileName.replace(".scenario.ts", ""),
      decisionPointId: point.decisionPointId,
      domain: point.sourceDomain,
      label: point.label,
    });
  }
  await writeFile(
    path.join(OUTPUT_DIR, "source-manifest.json"),
    `${JSON.stringify({ dataset: DATASET, revision: ISHIKI_REVISION, license: "Apache-2.0", sourceFiles, scenarios: trace }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `[ishiki] wrote ${selected.length} held-out scenarios\n`,
  );
}

if (import.meta.main) await generateIshikiScenarios();
