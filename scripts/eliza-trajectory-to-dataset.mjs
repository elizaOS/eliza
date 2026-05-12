#!/usr/bin/env node
/**
 * Convert recorded elizaOS runtime trajectories (~/.eliza/trajectories/) into
 * an eliza_native_v1 JSONL training dataset for the action_planner task.
 *
 * Unlike scripts/lifeops-benchmark-to-training-dataset.mjs (which needs a
 * lifeops-bench --run-dir + benchmark-report.json), this reads RecordedTrajectory
 * documents directly from the runtime's trajectory store.
 *
 * Reward signal:
 *   For each planner stage in a trajectory:
 *     1.0 if any subsequent tool stage (before the next planner iteration)
 *         reports tool.success === true
 *     0.0 otherwise (no tool fired, tool failed, or planner emitted nothing)
 *
 * Privacy: the file is routed through applyPrivacyFilter before being written
 * — required for every export path that touches real user trajectories.
 *
 * Usage:
 *   node scripts/eliza-trajectory-to-dataset.mjs \
 *     [--source ~/.eliza/trajectories] \
 *     [--output plugins/app-training/datasets/eliza_action_planner_real.jsonl] \
 *     [--include-zero-reward true]
 *
 * Output row shape (eliza_native_v1, matches parseJsonlDataset).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPrivacyFilter,
  createHashAnonymizer,
} from "../plugins/app-training/src/core/privacy-filter.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : fallback;
}

const sourceArg = arg("--source", join(homedir(), ".eliza", "trajectories"));
const sourceDir = resolve(sourceArg.replace(/^~/, homedir()));
const outputArg = arg(
  "--output",
  join(
    REPO_ROOT,
    "plugins",
    "app-training",
    "datasets",
    "eliza_action_planner_real.jsonl",
  ),
);
const outputPath = resolve(outputArg);
const includeZero =
  arg("--include-zero-reward", "true").toLowerCase() !== "false";

if (!existsSync(sourceDir)) {
  console.error(`[traj->ds] source dir not found: ${sourceDir}`);
  process.exit(2);
}

mkdirSync(dirname(outputPath), { recursive: true });

function* walkJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

/**
 * Returns reward + metadata for a planner stage at index `i` in `stages`.
 * Walks forward to find any tool stage before the next planner iteration.
 */
function plannerReward(stages, i) {
  for (let j = i + 1; j < stages.length; j += 1) {
    const sj = stages[j];
    if (sj.kind === "planner") return { reward: 0.0, downstreamTool: null };
    if (sj.kind === "tool") {
      const tool = sj.tool ?? {};
      if (tool.success === true) {
        return { reward: 1.0, downstreamTool: tool.name ?? null };
      }
      if (tool.success === false) {
        return { reward: 0.0, downstreamTool: tool.name ?? null };
      }
    }
  }
  return { reward: 0.0, downstreamTool: null };
}

const rawRows = [];
let trajectoriesScanned = 0;
let plannerStagesSeen = 0;
let skippedEmpty = 0;

for (const file of walkJson(sourceDir)) {
  let trajectory;
  try {
    trajectory = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  trajectoriesScanned += 1;
  const stages = Array.isArray(trajectory.stages) ? trajectory.stages : [];
  for (let i = 0; i < stages.length; i += 1) {
    const s = stages[i];
    if (s.kind !== "planner") continue;
    plannerStagesSeen += 1;
    const model = s.model ?? {};
    const messages = Array.isArray(model.messages) ? model.messages : [];
    const systemMsg = messages.find((m) => m && m.role === "system");
    const otherMsgs = messages.filter((m) => m && m.role !== "system");
    const responseText =
      typeof model.response === "string" ? model.response.trim() : "";
    const toolCalls = Array.isArray(model.toolCalls) ? model.toolCalls : [];

    if (!systemMsg || otherMsgs.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    if (!responseText && toolCalls.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    const { reward, downstreamTool } = plannerReward(stages, i);
    if (reward === 0.0 && !includeZero) continue;

    rawRows.push({
      // Reshape into the privacy-filter's expected step+llmCalls shape so
      // applyPrivacyFilter can walk + redact our content.
      trajectoryId: trajectory.trajectoryId ?? null,
      steps: [
        {
          llmCalls: [
            {
              systemPrompt: systemMsg.content ?? "",
              userPrompt: otherMsgs
                .map(
                  (m) =>
                    `[${m.role}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
                )
                .join("\n\n"),
              response:
                responseText ||
                (toolCalls.length ? JSON.stringify({ toolCalls }) : ""),
            },
          ],
        },
      ],
      metadata: {
        trajectoryId: trajectory.trajectoryId ?? null,
        agentId: trajectory.agentId ?? null,
        roomId: trajectory.roomId ?? null,
        stageId: s.stageId ?? null,
        downstreamTool,
        reward,
        rawMessages: messages,
        rawResponseText: responseText,
        rawToolCalls: toolCalls,
      },
    });
  }
}

const anonymizer = createHashAnonymizer("eliza-trajectories-v1");
const {
  trajectories: filtered,
  dropped,
  redactionCount,
  anonymizationCount,
} = applyPrivacyFilter(rawRows, { anonymizer });

function stripPrefix(text, role) {
  const prefix = `[${role}]\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

const lines = [];
for (const t of filtered) {
  const call = t.steps?.[0]?.llmCalls?.[0];
  const md = t.metadata ?? {};
  if (!call) continue;
  const userMessages = (md.rawMessages ?? []).filter(
    (m) => m && m.role !== "system",
  );
  const row = {
    format: "eliza_native_v1",
    boundary: "vercel_ai_sdk.generateText",
    request: {
      system: call.systemPrompt ?? "",
      messages:
        userMessages.length === 1
          ? [
              {
                role: userMessages[0].role,
                content: stripPrefix(
                  call.userPrompt ?? "",
                  userMessages[0].role,
                ),
              },
            ]
          : [{ role: "user", content: call.userPrompt ?? "" }],
    },
    response: {
      text: call.response ?? "",
      toolCalls: md.rawToolCalls ?? [],
    },
    reward: typeof md.reward === "number" ? md.reward : 0,
    metadata: {
      trajectoryId: md.trajectoryId,
      stageId: md.stageId,
      downstreamTool: md.downstreamTool,
    },
  };
  lines.push(JSON.stringify(row));
}

writeFileSync(outputPath, lines.join("\n") + (lines.length ? "\n" : ""));

const rewardCounts = lines.reduce(
  (acc, line) => {
    const r = JSON.parse(line).reward;
    if (r >= 0.5) acc.r1 += 1;
    else acc.r0 += 1;
    return acc;
  },
  { r1: 0, r0: 0 },
);

const metaPath = `${outputPath.replace(/\.jsonl$/, "")}.meta.json`;
const meta = {
  generatedAt: new Date().toISOString(),
  sourceDir,
  trajectoriesScanned,
  plannerStagesSeen,
  rawRows: rawRows.length,
  skippedEmpty,
  rowsAfterPrivacyFilter: filtered.length,
  rowsWritten: lines.length,
  dropped: dropped.length,
  rewardCounts,
  redactionCount,
  anonymizationCount,
};
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

console.log(
  `[traj->ds] scanned=${trajectoriesScanned} plannerStages=${plannerStagesSeen} rawRows=${rawRows.length} skippedEmpty=${skippedEmpty}`,
);
console.log(
  `[traj->ds] privacy filter: redacted=${redactionCount} anonymized=${anonymizationCount} dropped=${dropped.length}`,
);
console.log(
  `[traj->ds] wrote ${lines.length} rows (reward=1: ${rewardCounts.r1}, reward=0: ${rewardCounts.r0}) -> ${outputPath}`,
);
console.log(`[traj->ds] meta -> ${metaPath}`);
