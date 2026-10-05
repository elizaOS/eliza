/** Isolates agent end-to-end state from the developer environment. */
import { afterAll } from "vitest";
import { withIsolatedTestHome } from "./test-env";

process.env.VITEST = "true";
process.env.LOG_LEVEL ??= "error";
const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());
