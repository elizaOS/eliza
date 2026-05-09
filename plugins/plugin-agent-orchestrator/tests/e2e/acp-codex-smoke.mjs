#!/usr/bin/env node
/**
 * Real e2e smoke: spawn AcpService against installed acpx + codex, send a prompt,
 * verify task_complete fires and response is sane.
 *
 * Prerequisites:
 *   - acpx installed globally (`npm install -g acpx@latest`)
 *   - codex installed and authenticated
 *
 * Run from repo root after `npm run build`:
 *   node tests/e2e/acp-codex-smoke.mjs
 *
 * Exits 0 on pass, 1 on fail.
 */
import { AcpService } from "../../dist/services/acp-service.js";

const fakeRuntime = {
  logger: {
    debug: () => {},
    info: () => {},
    warn: (...a) => console.warn("[warn]", ...a),
    error: (...a) => console.error("[error]", ...a),
  },
  getSetting: (k) => process.env[k],
  agentId: "e2e-smoke",
};

const svc = new AcpService(fakeRuntime);
if (svc.start) await svc.start();

const events = [];
svc.onSessionEvent((sid, name, data) => {
  events.push({ sid, name, dataPreview: JSON.stringify(data).slice(0, 100) });
});

console.log("=== spawning ===");
const r = await svc.spawnSession({
  agentType: "codex",
  workdir: "/tmp/acp-e2e-smoke",
  approvalPreset: "permissive",
});
console.log("  sessionId:", r.sessionId.slice(0, 8));

console.log("=== sending prompt ===");
const promptResult = await svc.sendPrompt(
  r.sessionId,
  "what is 7 plus 8? respond with just the number, nothing else.",
);
console.log("  stopReason:", promptResult.stopReason);
console.log("  durationMs:", promptResult.durationMs);
console.log("  response:", JSON.stringify(promptResult.finalText));

const completes = events.filter((e) => e.name === "task_complete");
const responseValid = promptResult.finalText.includes("15");

console.log("\n=== verdict ===");
console.log("  task_complete events:", completes.length);
console.log("  response contains '15':", responseValid);

if (
  completes.length > 0 &&
  responseValid &&
  promptResult.stopReason === "end_turn"
) {
  console.log("\n✓ E2E SMOKE PASSED");
  process.exit(0);
} else {
  console.log("\n✗ E2E SMOKE FAILED");
  process.exit(1);
}
