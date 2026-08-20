/**
 * Runs Git commands after a real warm-session claim and executable-authority
 * capture. The parent integration test launches this as a separate Bun process
 * so bootstrap credentials and host PATH state cannot leak across sessions.
 */
import { spawnSync } from "node:child_process";
import {
  applyHostExecutionBaseline,
  captureHostExecutionBaseline,
  resolveHostExecutable,
} from "@elizaos/shared/host-execution-env";
import { consumeWarmClaimToken } from "../../../../../packages/examples/code/src/acp-bootstrap.js";
import { AcpWarmSessionClaim } from "../../../../../packages/examples/code/src/acp-session-claim.js";

type ChildInput = {
  claim: { token: string; env: Record<string, string>; executionPath: string };
  cwd: string;
  commands: string[][];
};

const input = JSON.parse(await Bun.stdin.text()) as ChildInput;
const claim = new AcpWarmSessionClaim(consumeWarmClaimToken());
claim.apply({ elizaSessionClaim: input.claim });
captureHostExecutionBaseline();
const git = resolveHostExecutable("git");
if (!git)
  throw new Error("claimed Git wrapper did not become executable authority");
const env = applyHostExecutionBaseline(process.env);
for (const args of input.commands) {
  const result = spawnSync(git, args, {
    cwd: input.cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || `git exited ${result.status ?? "unknown"}`,
    );
  }
}
process.stdout.write(JSON.stringify({ resolvedGit: git }));
