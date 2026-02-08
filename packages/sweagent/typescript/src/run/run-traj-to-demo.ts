/**
 * Convert a trajectory file to a yaml file for editing of demos.
 * You can then load the yaml file with run_replay to replay the actions in an environment
 * to get environment output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { JsonObject, JsonValue } from "../json";
import { getLogger } from "../utils/log";

const logger = getLogger("traj2demo");

const DEMO_COMMENT = `# This is a demo file generated from trajectory file:
# {traj_path}
# You can use this demo file to replay the actions in the trajectory with run_replay.
# You can edit the content of the actions in this file to modify the replay behavior.
# NOTICE:
#         Only the actions of the assistant will be replayed.
#         You do not need to modify the observation's contents or any other fields.
#         You can add or remove actions to modify the replay behavior.`;

/**
 * Save demo data as a yaml file with proper header
 */
function saveDemo(data: JsonValue, file: string, trajPath: string): void {
  const content = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });

  const header = DEMO_COMMENT.replace("{traj_path}", trajPath);
  fs.writeFileSync(file, `${header}\n${content}`);
}

/**
 * Convert trajectory to action demo
 */
export function convertTrajToActionDemo(
  trajPath: string,
  outputFile: string,
  includeUser: boolean = false,
): void {
  const traj = JSON.parse(fs.readFileSync(trajPath, "utf-8")) as JsonObject;

  let replayConfig: JsonValue | undefined = traj.replay_config;
  if (typeof replayConfig === "string") {
    replayConfig = JSON.parse(replayConfig) as JsonValue;
  }

  const historyVal = traj.history;
  const history = Array.isArray(historyVal) ? historyVal : [];

  const copyFields = new Set([
    "content",
    "role",
    "tool_calls",
    "agent",
    "message_type",
    "tool_call_ids",
  ]);

  const admissibleRoles = includeUser
    ? new Set(["assistant", "user", "tool"])
    : new Set(["assistant"]);

  const filteredHistory = history
    .filter((step: JsonValue) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        return false;
      }
      const obj = step as JsonObject;
      const role = obj.role;
      if (typeof role !== "string" || !admissibleRoles.has(role)) {
        return false;
      }
      const agent = obj.agent;
      if (
        agent !== undefined &&
        agent !== null &&
        typeof agent === "string" &&
        agent !== "main" &&
        agent !== "primary"
      ) {
        return false;
      }
      return obj.is_demo !== true;
    })
    .map((step: JsonValue): JsonObject => {
      const obj = step as JsonObject;
      const filtered: JsonObject = {};
      for (const key of copyFields) {
        const v = obj[key];
        if (v !== undefined) {
          filtered[key] = v;
        }
      }
      return filtered;
    });

  const outputData: JsonObject = {
    history: filteredHistory,
    replay_config: replayConfig,
  };

  saveDemo(outputData, outputFile, trajPath);
  logger.info(`Saved demo to ${outputFile}`);
}

/**
 * Main function for traj-to-demo conversion
 */
export function trajToDemo(
  trajPath: string,
  outputDir: string = "./demos",
  suffix: string = "",
  overwrite: boolean = false,
  includeUser: boolean = false,
): void {
  const trajDir = path.dirname(trajPath);
  const trajName = path.basename(trajPath, ".traj");
  const outputSubdir = path.basename(trajDir) + suffix;
  const outputFile = path.join(
    outputDir,
    outputSubdir,
    `${trajName}.demo.yaml`,
  );

  if (fs.existsSync(outputFile) && !overwrite) {
    throw new Error(
      `Output file already exists: ${outputFile}. Use --overwrite to overwrite.`,
    );
  }

  const outputFileDir = path.dirname(outputFile);
  if (!fs.existsSync(outputFileDir)) {
    fs.mkdirSync(outputFileDir, { recursive: true });
  }

  convertTrajToActionDemo(trajPath, outputFile, includeUser);
}
