/**
 * Subprocess participant for the ACP provisioning concurrency tests. Each
 * worker enters the production filesystem protocol and records only after a
 * complete executable has been published, allowing the parent test to prove
 * that waiters never return from a partial build.
 */
import { appendFileSync } from "node:fs";
import { provisionWorkspaceElizaCodeAcp } from "../../src/services/acp-provisioning.js";

const workspaceRoot = process.argv[2];
const eventsPath = process.env.ACP_PROVISION_EVENTS;

if (!workspaceRoot || !eventsPath) {
  throw new Error("ACP provision worker requires a workspace and event log");
}

provisionWorkspaceElizaCodeAcp(workspaceRoot);
appendFileSync(eventsPath, `returned:${process.pid}\n`);
