import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { getLatestSnapshot } from "./store";
import type { DashboardSnapshot } from "./types";

async function loadSnapshotFromDisk(reportsDir: string): Promise<DashboardSnapshot | null> {
  const snapshotPath = path.join(process.cwd(), reportsDir, "latest.json");
  try {
    const content = await readFile(snapshotPath, "utf8");
    return JSON.parse(content) as DashboardSnapshot;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function renderHtml(snapshot: DashboardSnapshot | null): string {
  if (!snapshot) {
    return `<!doctype html>
<html><body style="font-family: sans-serif; padding: 24px;">
<h1>ElizaOK Dashboard</h1>
<p>No scan snapshot available yet.</p>
</body></html>`;
  }

  const topCandidates = snapshot.topCandidates
    .slice(0, 5)
    .map(
      (candidate) =>
        `<li><strong>${candidate.tokenSymbol}</strong> - ${candidate.recommendation} - ${candidate.score}/100</li>`
    )
    .join("");

  const gooCandidates = snapshot.topGooCandidates
    .slice(0, 5)
    .map(
      (candidate) =>
        `<li><strong>Agent ${candidate.agentId}</strong> - ${candidate.recommendation} - ${candidate.score}/100</li>`
    )
    .join("");

  return `<!doctype html>
<html>
<body style="font-family: sans-serif; padding: 24px; max-width: 900px; margin: 0 auto;">
<h1>ElizaOK Dashboard</h1>
<p>Generated at: <code>${snapshot.generatedAt}</code></p>
<p>Run ID: <code>${snapshot.summary.runId}</code></p>
<p>Scanned ${snapshot.summary.candidateCount} memecoin candidates and ${snapshot.summary.gooAgentCount} Goo agents.</p>
<h2>Top Memecoin Candidates</h2>
<ul>${topCandidates || "<li>No candidates yet.</li>"}</ul>
<h2>Top Goo Targets</h2>
<ul>${gooCandidates || "<li>No Goo candidates yet.</li>"}</ul>
<p>Latest report: <code>${snapshot.reportPath}</code></p>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AgentRuntime
): Promise<void> {
  const config = getDiscoveryConfig();
  const snapshot = getLatestSnapshot() || (await loadSnapshotFromDisk(config.reportsDir));
  const url = req.url || "/";

  if (url === "/health") {
    sendJson(res, 200, {
      status: "ok",
      agent: runtime.character.name,
      discoveryEnabled: config.enabled,
      gooEnabled: config.goo.enabled,
      latestRunId: snapshot?.summary.runId ?? null,
    });
    return;
  }

  if (url === "/api/elizaok/latest") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, snapshot);
    return;
  }

  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml(snapshot));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function startDashboardServer(runtime: AgentRuntime) {
  const config = getDiscoveryConfig();
  if (!config.dashboard.enabled) {
    runtime.logger.info("ElizaOK dashboard server disabled");
    return null;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, runtime).catch((error) => {
      runtime.logger.error({ error }, "ElizaOK dashboard server request failed");
      sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(config.dashboard.port, () => {
    runtime.logger.info(
      { port: config.dashboard.port },
      "ElizaOK dashboard server started"
    );
  });

  return server;
}
