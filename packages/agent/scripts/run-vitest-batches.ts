/** Agent test discovery policy; repository tooling owns process/evidence handling. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVitestBatches } from "../../scripts/lib/vitest-batches.ts";

export {
  createBatches,
  createVitestInvocation,
  mergeBatchJunit as mergeAgentJunit,
  parseBatchTestArgs as parseAgentTestArgs,
  positiveInteger,
  resolveBunExecutable,
} from "../../scripts/lib/vitest-batches.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const roots = ["src", "test", "scripts"];

export const agentTestInclude = roots.map(
  (root) => `${root}/**/*.test.{ts,tsx}`,
);
export const agentTestExclude = ["**/dist/**", "**/node_modules/**"];

export function isDefaultAgentTest(relativePath: string) {
  return (
    agentTestInclude.some((pattern) =>
      path.matchesGlob(relativePath, pattern),
    ) &&
    !agentTestExclude.some((pattern) => path.matchesGlob(relativePath, pattern))
  );
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  runVitestBatches({
    packageRoot,
    roots,
    isEligible: isDefaultAgentTest,
    label: "agent-test",
    envPrefix: "AGENT_TEST",
  }).catch((error) => {
    // error-policy:J1 Convert orchestration failures into a visible package-test failure.
    console.error(
      `[agent-test] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
