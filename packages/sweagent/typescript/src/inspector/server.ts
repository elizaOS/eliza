/**
 * Inspector server for viewing agent trajectories
 * Converted from sweagent/inspector/server.py
 */

import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import * as yaml from "js-yaml";
import { resolvePathWithinRoot } from "../../../security/safe-path.js";
import { getLogger } from "../utils/log";

const logger = getLogger("inspector-server");

interface TrajectoryStep {
  thought: string;
  action: string;
  response: string;
  observation: string;
  messages?: Array<{ role: string; content: string }>;
}

interface ModelStats {
  instanceCost?: number;
  totalCost?: number;
  instanceInputTokens?: number;
  instanceOutputTokens?: number;
  instanceCallCount?: number;
}

interface TrajectoryContent {
  history: Array<{ role: string; content: string }>;
  trajectory: TrajectoryStep[];
  info: {
    exitStatus?: string;
    submission?: string;
    modelStats?: ModelStats;
  };
  environment?: string;
}

function addProblemStatement(content: TrajectoryContent): TrajectoryContent {
  let problemStatement = "";

  for (const item of content.history || []) {
    if (item.role === "user") {
      problemStatement = item.content;
      break;
    }
  }

  if (problemStatement) {
    content.trajectory.unshift({
      thought: "",
      action: "",
      response: "",
      observation: problemStatement,
      messages: [{ role: "system", content: problemStatement }],
    });
  }

  return content;
}

function appendExit(content: TrajectoryContent): TrajectoryContent {
  const exitStatus = content.info?.exitStatus;

  if (!exitStatus) {
    return content;
  }

  if (exitStatus.startsWith("submitted")) {
    if (content.info.submission) {
      content.trajectory.push({
        thought: "Submitting solution",
        action: "Model Submission",
        response: "Submitting solution",
        observation: content.info.submission,
        messages: [],
      });
    }
  } else if (exitStatus === "exit_cost" || exitStatus === "exit_context") {
    const observation =
      exitStatus === "exit_cost"
        ? "Exit due to cost limit"
        : "Exit due to context limit";

    content.trajectory.push({
      thought: "Exit",
      action: "Exit",
      response: "",
      observation,
      messages: [],
    });
  } else if (exitStatus === "exit_error") {
    content.trajectory.push({
      thought: "Exit",
      action: "Exit due to error",
      response: "",
      observation: "Exit due to error",
      messages: [],
    });
  } else if (exitStatus === "exit_format") {
    content.trajectory.push({
      thought: "Exit",
      action: "Exit due to format error",
      response: "",
      observation: "Exit due to format error",
      messages: [],
    });
  }

  return content;
}

function addModelStats(content: TrajectoryContent): TrajectoryContent {
  const modelStats = content.info?.modelStats;

  if (modelStats) {
    const statsText = `Model API Usage:
Instance Cost: $${modelStats.instanceCost?.toFixed(4) || 0}
Total Cost: $${modelStats.totalCost?.toFixed(4) || 0}
Input Tokens: ${modelStats.instanceInputTokens || 0}
Output Tokens: ${modelStats.instanceOutputTokens || 0}
API Calls: ${modelStats.instanceCallCount || 0}`;

    content.trajectory.push({
      thought: "",
      action: "Model Stats",
      response: "",
      observation: statsText,
      messages: [],
    });
  }

  return content;
}

function getTrajectory(filePath: string): TrajectoryContent | null {
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    let content: TrajectoryContent;

    try {
      content = JSON.parse(fileContent);
    } catch {
      content = yaml.load(fileContent) as TrajectoryContent;
    }

    content = addProblemStatement(content);
    content = appendExit(content);
    content = addModelStats(content);

    if (content.environment) {
      content.trajectory.push({
        thought: "",
        action: "Environment",
        response: "",
        observation: content.environment,
        messages: [],
      });
    }

    return content;
  } catch (error) {
    logger.error(`Error reading trajectory file ${filePath}:`, error);
    return null;
  }
}

export function startInspectorServer(options: {
  port?: number;
  host?: string;
  trajectoryDir?: string;
  staticDir?: string;
}): void {
  const app = express();
  const port = options.port || 8000;
  const host = options.host ?? "127.0.0.1";
  const trajectoryDir = options.trajectoryDir || "./trajectories";
  const staticDir =
    options.staticDir || path.join(__dirname, "../../sweagent/inspector");

  if (!fs.existsSync(trajectoryDir)) {
    fs.mkdirSync(trajectoryDir, { recursive: true });
  }

  app.use(express.static(staticDir));

  app.get("/api/trajectories", (_req, res) => {
    try {
      const files = fs
        .readdirSync(trajectoryDir)
        .filter(
          (file) =>
            file.endsWith(".traj") ||
            file.endsWith(".yaml") ||
            file.endsWith(".json"),
        )
        .map((file) => ({
          name: file,
          path: path.join(trajectoryDir, file),
          modified: fs.statSync(path.join(trajectoryDir, file)).mtime,
        }))
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());

      res.json(files);
    } catch (error) {
      logger.error("Error listing trajectories:", error);
      res.status(500).json({ error: "Failed to list trajectories" });
    }
  });

  // GHSA-jvqc-qp6c-g58f: :filename is attacker-controlled; must stay under trajectoryDir.
  app.get("/api/trajectory/:filename", (req, res) => {
    const filename = req.params.filename;
    let filePath: string;
    try {
      filePath = resolvePathWithinRoot(trajectoryDir, filename);
    } catch {
      return res.status(400).json({ error: "Invalid path" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Trajectory not found" });
    }

    const trajectory = getTrajectory(filePath);

    if (!trajectory) {
      return res.status(500).json({ error: "Failed to parse trajectory" });
    }

    return res.json(trajectory);
  });

  app.get("/api/stats", (_req, res) => {
    try {
      const files = fs
        .readdirSync(trajectoryDir)
        .filter(
          (file) =>
            file.endsWith(".traj") ||
            file.endsWith(".yaml") ||
            file.endsWith(".json"),
        );

      const stats = {
        totalTrajectories: files.length,
        recentTrajectories: files.slice(0, 10).map((file) => {
          const trajectory = getTrajectory(
            resolvePathWithinRoot(trajectoryDir, file),
          );
          return {
            file,
            steps: trajectory?.trajectory.length || 0,
            exitStatus: trajectory?.info.exitStatus || "unknown",
            cost: trajectory?.info.modelStats?.instanceCost || 0,
          };
        }),
      };

      res.json(stats);
    } catch (error) {
      logger.error("Error computing statistics:", error);
      res.status(500).json({ error: "Failed to compute statistics" });
    }
  });

  app.listen(port, host, () => {
    logger.info(`Inspector server running at http://${host}:${port}`);
    logger.info(`Serving trajectories from: ${trajectoryDir}`);
    logger.info(`Static files from: ${staticDir}`);
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = parseInt(
    args.find((arg) => arg.startsWith("--port="))?.split("=")[1] || "8000",
    10,
  );
  const trajectoryDir =
    args.find((arg) => arg.startsWith("--dir="))?.split("=")[1] ||
    "./trajectories";

  startInspectorServer({ port, trajectoryDir });
}
