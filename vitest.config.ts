// The tools' own tests: vibestack/{testing,stories,design}/test.
import { project } from "./vibestack/testing/vitest.ts";

export default project({ root: import.meta.dirname, tests: ["vibestack/testing/test/*.test.ts", "vibestack/stories/test/*.test.ts", "vibestack/design/test/*.test.ts"] });
