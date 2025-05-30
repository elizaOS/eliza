import {
  createUniqueUuid as coreCreateUniqueUuid,
  findEntityByName as coreFindEntityByName,
  formatEntities as coreFormatEntities,
  getEntityDetails as coreGetEntityDetails,
} from '../../entities';

import { type Entity, type IAgentRuntime, type Memory } from './types';

import {
  type IAgentRuntime as coreIAgentRuntime,
  type Memory as coreMemory,
  type State,
  type UUID,
} from '../../types';

/**
 * Finds an entity by name in the given runtime environment.
 *
 * @param {IAgentRuntime} runtime - The agent runtime environment.
 * @param {Memory} message - The memory message containing relevant information.
 * @param {State} state - The current state of the system.
 * @returns {Promise<Entity | null>} A promise that resolves to the found entity or null if not found.
 */
export async function findEntityByName(
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<Entity | null> {
  const rt: any = runtime;
  return coreFindEntityByName(rt as coreIAgentRuntime, message as coreMemory, state);
}

/**
 * Function to create a unique UUID based on the runtime and base user ID.
 *
 * @param {RuntimeContext} runtime - The runtime context object.
 * @param {UUID|string} baseUserId - The base user ID to use in generating the UUID.
 * @returns {UUID} - The unique UUID generated based on the runtime and base user ID.
 */
export const createUniqueUuid = (runtime: IAgentRuntime, baseUserId: UUID | string): UUID => {
  return coreCreateUniqueUuid(runtime, baseUserId);
};

/**
 * Retrieves entity details for a specific room from the database.
 *
 * @param {Object} params - The input parameters
 * @param {IAgentRuntime} params.runtime - The Agent Runtime instance
 * @param {UUID} params.roomId - The ID of the room to retrieve entity details for
 * @returns {Promise<Array>} - A promise that resolves to an array of unique entity details
 */
export async function getEntityDetails({
  runtime,
  roomId,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
}) {
  return coreGetEntityDetails({ runtime: runtime as any, roomId });
}

/**
 * Format the given entities into a string representation.
 *
 * @param {Object} options - The options object.
 * @param {Entity[]} options.entities - The list of entities to format.
 * @returns {string} A formatted string representing the entities.
 */
export function formatEntities({ entities }: { entities: Entity[] }) {
  return coreFormatEntities({ entities: entities as any });
}
