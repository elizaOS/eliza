// The standalone LOG_LEVEL action was consolidated into the polymorphic LOGS
// action (op="set_level") in ./logs.ts. This shim exists only because the
// actions barrel (`./index.ts`) re-exports `./log-level.js` and the task
// constraints forbid touching it. Once the barrel is updated, this file can
// be deleted.
export { logLevelAction } from "./logs.js";
