#!/usr/bin/env node
import {
  defaultRegistryPath,
  listRegistryEntries,
} from "./dev-server-registry.mjs";

const includeStopped = process.argv.includes("--all");
const json = process.argv.includes("--json");
const registryPath = defaultRegistryPath();
const rows = await listRegistryEntries({ registryPath, includeStopped });

if (json) {
  console.log(JSON.stringify({ registryPath, servers: rows }, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(
    `No ${includeStopped ? "registered" : "running"} shared dev servers.`,
  );
  console.log(`registry: ${registryPath}`);
  process.exit(0);
}

console.log(`registry: ${registryPath}`);
console.log("PORT\tAPI\tPID\tSTATE\tWORKTREE");
for (const row of rows) {
  const state = row.running ? "running" : "stopped";
  console.log(
    `${row.uiPort}\t${row.apiPort}\t${row.pid ?? "-"}\t${state}\t${row.worktree}`,
  );
}
