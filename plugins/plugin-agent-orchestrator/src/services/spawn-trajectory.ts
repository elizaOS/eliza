import {
  type IAgentRuntime,
  type SpawnTrajectoryHandle,
  spawnWithTrajectoryLink,
} from "@elizaos/core";

export const TRAJECTORY_PARENT_STEP_METADATA_KEY = "parentTrajectoryStepId";
export const TRAJECTORY_CHILD_STEP_METADATA_KEY = "trajectoryChildStepId";
export const TRAJECTORY_LINK_SOURCE_METADATA_KEY = "trajectoryLinkSource";
export const TRAJECTORY_PARENT_STEP_ENV_KEY = "ELIZA_PARENT_TRAJECTORY_STEP_ID";
export const TRAJECTORY_CHILD_STEP_ENV_KEY = "ELIZA_TRAJECTORY_CHILD_STEP_ID";

export interface LinkedSpawnContext {
  parentStepId?: string;
  metadata: Record<string, unknown>;
  env: Record<string, string> | undefined;
  linkChild: SpawnTrajectoryHandle["linkChild"];
}

interface WithLinkedSpawnOptions<T> {
  source: string;
  metadata?: Record<string, unknown>;
  env?: Record<string, string>;
  childId?: (result: T) => string | undefined;
}

function cleanParentStepId(handle: SpawnTrajectoryHandle): string | undefined {
  const parentStepId = handle.parentStepId?.trim();
  return parentStepId && parentStepId.length > 0 ? parentStepId : undefined;
}

export function buildLinkedSpawnMetadata(
  metadata: Record<string, unknown> | undefined,
  handle: SpawnTrajectoryHandle,
  source: string,
): Record<string, unknown> {
  const parentStepId = cleanParentStepId(handle);
  return {
    ...metadata,
    ...(parentStepId
      ? {
          [TRAJECTORY_PARENT_STEP_METADATA_KEY]: parentStepId,
          [TRAJECTORY_LINK_SOURCE_METADATA_KEY]: source,
        }
      : {}),
  };
}

export function buildLinkedSpawnEnv(
  env: Record<string, string> | undefined,
  handle: SpawnTrajectoryHandle,
): Record<string, string> | undefined {
  const parentStepId = cleanParentStepId(handle);
  if (!parentStepId) return env;
  return {
    ...env,
    [TRAJECTORY_PARENT_STEP_ENV_KEY]: parentStepId,
  };
}

export async function withLinkedSpawn<T>(
  runtime: IAgentRuntime | null | undefined,
  options: WithLinkedSpawnOptions<T>,
  spawn: (context: LinkedSpawnContext) => Promise<T> | T,
): Promise<T> {
  return spawnWithTrajectoryLink(
    runtime,
    { source: options.source, metadata: options.metadata },
    async (handle) => {
      const context: LinkedSpawnContext = {
        parentStepId: cleanParentStepId(handle),
        metadata: buildLinkedSpawnMetadata(
          options.metadata,
          handle,
          options.source,
        ),
        env: buildLinkedSpawnEnv(options.env, handle),
        linkChild: handle.linkChild,
      };
      const result = await spawn(context);
      const childStepId = options.childId?.(result)?.trim();
      if (childStepId) {
        await handle.linkChild(childStepId);
      }
      return result;
    },
  );
}
