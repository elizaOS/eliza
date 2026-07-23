/**
 * Pendant session persistence owned by the runtime.
 *
 * The route layer consumes the repository interface; SQL migrations consume the
 * Drizzle schema exported here through the bundled `eliza` plugin.
 */

export {
  createPendantSessionRepository,
  InMemoryPendantSessionRepository,
  type PendantSessionRepository,
  SqlPendantSessionRepository,
  type StoredCaptureLease,
  type StoredPendantSessionDocument,
} from "./repository.ts";
export { pendantSessionSchema } from "./schema.ts";
