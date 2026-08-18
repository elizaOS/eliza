/**
 * Unit-test bootstrap keeps the durable Smithers task path off so create-task
 * coverage exercises the fast direct-prompt path. The durable runner, executor,
 * and integration glue are tested directly in smithers-task suites, while
 * production defaults remain enabled through shouldUseSmithersTaskRunner.
 */
import { tmpdir } from "node:os";
import { delimiter, isAbsolute } from "node:path";
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";

// Production entrypoints capture PATH before runtime configuration. Mirror
// that boundary in tests while excluding ambient shell shorthand such as `~`,
// which is not an executable-search authority accepted by the host contract.
const ambientPath = process.env.PATH;
process.env.PATH = ambientPath
  ?.split(delimiter)
  .filter((entry) => isAbsolute(entry))
  .join(delimiter);
captureHostExecutionBaseline();
process.env.PATH = ambientPath;

if (process.env.ELIZA_ORCHESTRATOR_SMITHERS === undefined) {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
}

// The deterministic completion-residuals gate (production default ON) probes
// the reporting session's workdir with real git. Event-bridge/lifecycle suites
// seed placeholder workdirs like "/repo", which the fail-closed gate would
// (correctly) flag as unverifiable and re-engage — changing the states those
// suites pin. Default it off here; the gate's own suites
// (completion-residuals.test.ts, auto-goal-verify.test.ts) re-enable it against
// REAL temp git workspaces.
if (process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE === undefined) {
  process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "0";
}

// The residuals gate and change-set capture probe a session's workdir with real
// git (`git rev-parse --is-inside-work-tree`, `git ls-files --others`). Tests
// build throwaway workdirs under the OS temp dir; on a host where an ANCESTOR of
// the temp dir is itself a git work tree (a stray `/.git`, which exists on some
// CI/VPS images), git discovery walks up past the fixture into that repo and its
// dirt leaks in — a non-git fixture reads as "inside a work tree", and pre-seeded
// files get scooped into change sets. Cap discovery at the temp root so fixtures
// are hermetic regardless of the host's ambient git layout. Fixtures that create
// their own repo under the temp dir still find it before hitting the ceiling.
if (process.env.GIT_CEILING_DIRECTORIES === undefined) {
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
}
