/**
 * LifeOps test runtime helper — thin re-export of the canonical
 * createRealTestRuntime as createLifeOpsTestRuntime so the LifeOps
 * test suite can stay on its own import surface.
 *
 * This shim exists because several LifeOps integration tests import
 * `./helpers/runtime.js` but the canonical helper lives at
 * `packages/app-core/test/helpers/real-runtime.ts`. Without this
 * re-export, Vitest fails with "Cannot find module './helpers/runtime.js'"
 * when these tests are collected.
 */

export {
  createRealTestRuntime as createLifeOpsTestRuntime,
  type RealTestRuntimeOptions,
  type RealTestRuntimeResult,
} from "../../../../packages/app-core/test/helpers/real-runtime.ts";
