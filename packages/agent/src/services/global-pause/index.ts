/**
 * Runtime global-pause store: the vacation / pause-mode singleton consulted by
 * the scheduled-task runner, surfaced through the registered
 * {@link GlobalPauseService}. Cache-backed (no SQL), single canonical key.
 */

export {
  GLOBAL_PAUSE_SERVICE,
  GlobalPauseService,
  resolveGlobalPauseService,
} from "./service.ts";
export {
  createGlobalPauseStore,
  GLOBAL_PAUSE_CACHE_KEY,
  type GlobalPauseStatus,
  type GlobalPauseStore,
  type GlobalPauseWindow,
} from "./store.ts";
