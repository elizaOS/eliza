/**
 * Completes the progressive-content external mutant catalog with real private
 * artifact readback and selected-live credential preflight operations.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createCoreProgressiveContentExternalMutantExecutors,
  type ProgressiveContentExternalMutantExecutor,
  type ProgressiveContentExternalMutantId,
} from "@elizaos/core/testing";
import {
  deleteShellOutputArtifact,
  persistShellOutputByteArtifact,
  readShellOutputArtifactBytePage,
} from "@elizaos/plugin-coding-tools/lib/shell-output-artifact";
import { scenarioLiveProviderPreflightProblems } from "./runtime-factory.ts";

const OWNER_AGENT = "00000000-0000-4000-8000-000000000101";
const OWNER_CONVERSATION = "00000000-0000-4000-8000-000000000102";

class ExternalMutantKilledError extends Error {
  readonly vector: string;

  constructor(vector: string, cause: unknown) {
    super(`Progressive-content external mutant rejected by ${vector}`, {
      cause,
    });
    this.name = "ExternalMutantKilledError";
    this.vector = vector;
  }
}

function reexternalizedArtifactExecutor(): ProgressiveContentExternalMutantExecutor {
  return {
    async execute() {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "progressive-mutant-artifact-"),
      );
      const previousStateDir = process.env.ELIZA_STATE_DIR;
      const previousTtl = process.env.SHELL_JOB_TTL_MS;
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.SHELL_JOB_TTL_MS = "60000";
      let originalHandle: string | undefined;
      try {
        const artifact = await persistShellOutputByteArtifact({
          chunks: (async function* () {
            yield Buffer.from("stable artifact identity\n", "utf8");
          })(),
          stream: "stdout",
          exitCode: 0,
          timedOut: false,
          signal: null,
          ownerAgentId: OWNER_AGENT,
          ownerConversationId: OWNER_CONVERSATION,
        });
        originalHandle = artifact.handle;
        const suffix = artifact.handle.endsWith("0") ? "1" : "0";
        const reexternalizedHandle = `${artifact.handle.slice(0, -1)}${suffix}`;
        const readback = await readShellOutputArtifactBytePage({
          handle: reexternalizedHandle,
          stream: "stdout",
          offset: 0,
          limit: 64 * 1024,
          requesterAgentId: OWNER_AGENT,
          requesterConversationId: OWNER_CONVERSATION,
        });
        if (!readback.ok && readback.reason === "unavailable") {
          throw new ExternalMutantKilledError(
            "artifact-identity",
            new Error(
              "re-externalized handle cannot resolve the published bytes",
            ),
          );
        }
        throw new Error(
          "re-externalized artifact identity unexpectedly resolved",
        );
      } finally {
        if (originalHandle) {
          await deleteShellOutputArtifact({
            handle: originalHandle,
            requesterAgentId: OWNER_AGENT,
            requesterConversationId: OWNER_CONVERSATION,
          });
        }
        if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
        else process.env.ELIZA_STATE_DIR = previousStateDir;
        if (previousTtl === undefined) delete process.env.SHELL_JOB_TTL_MS;
        else process.env.SHELL_JOB_TTL_MS = previousTtl;
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  };
}

function selectedLiveCredentialExecutor(): ProgressiveContentExternalMutantExecutor {
  return {
    execute() {
      const env: NodeJS.ProcessEnv = {
        SCENARIO_JUDGE_REQUIRE_INDEPENDENT: "0",
      };
      const preflightProblems = scenarioLiveProviderPreflightProblems(
        "openai",
        undefined,
        env,
      );
      const mutatedOutcome = {
        status: "skipped" as const,
        reason: preflightProblems.join("; "),
      };
      if (
        mutatedOutcome.status === "skipped" &&
        preflightProblems.some((problem) =>
          problem.includes("--provider openai requires OPENAI_API_KEY"),
        )
      ) {
        throw new ExternalMutantKilledError(
          "live-credentials",
          new Error(
            "an explicitly selected live provider may not become a skip",
          ),
        );
      }
      throw new Error("selected-live credential mutant was not observed");
    },
  };
}

/** Build the exact 13-member, production-backed external executor registry. */
export function createProgressiveContentExternalMutantExecutors(): Record<
  ProgressiveContentExternalMutantId,
  ProgressiveContentExternalMutantExecutor
> {
  return {
    ...createCoreProgressiveContentExternalMutantExecutors(),
    "readback-artifact-identity-reexternalized":
      reexternalizedArtifactExecutor(),
    "selected-live-credentials-become-skip": selectedLiveCredentialExecutor(),
  };
}
