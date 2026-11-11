/** A plugin file that happens to be named like a runtime file is the caller,
 * not the runtime: the internal-frame filter must only match the runtime's
 * own files, never any `runtime.ts`, `useModel*.ts`, or `getModel*.ts` under
 * a plugin. The same holds for a plugin function named
 * `resolveModelRegistration`. */

import { describe, expect, it } from "vitest";
import {
	captureModelLookupCallerFromStack,
	type ModelLookupCallerTrace,
} from "../src/utils/model-lookup-caller";

function trace(stack: string): ModelLookupCallerTrace | undefined {
	return captureModelLookupCallerFromStack(stack);
}

const CORE_FRAME =
	"    at AgentRuntime.useModel (/repo/packages/core/src/runtime.ts:500:10)";

describe("captureModelLookupCallerFromStack plugin files named like runtime files", () => {
	it("credits a plugin whose only frame is a file named runtime.ts", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at doThing (/repo/plugins/my-plugin/src/runtime.ts:20:5)`),
		).toEqual({ caller: "my-plugin", callerStack: ["my-plugin"] });
	});

	it("credits a plugin file named useModel.ts", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at helper (/repo/plugins/foo/src/useModel.ts:5:5)`),
		).toEqual({ caller: "foo", callerStack: ["foo"] });
	});

	it("credits a plugin file named getModelHelper.ts", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at helper (/repo/packages/plugin-bar/src/getModelHelper.ts:1:1)`),
		).toEqual({ caller: "plugin-bar", callerStack: ["plugin-bar"] });
	});

	it("credits a plugin package whose only frame is a file named runtime.ts", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at setup (/repo/packages/plugin-foo/src/runtime.ts:1:1)`),
		).toEqual({ caller: "plugin-foo", callerStack: ["plugin-foo"] });
	});

	it("credits a plugin function named resolveModelRegistration", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at resolveModelRegistration (/repo/plugins/foo/src/index.ts:1:1)`),
		).toEqual({ caller: "foo", callerStack: ["foo"] });
	});

	it("still skips the runtime's own runtime.ts frame", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at other (/repo/packages/core/src/runtime.ts:10:5)`),
		).toBeUndefined();
	});

	it("still skips an installed @elizaos/core frame and credits the plugin", () => {
		expect(
			trace(`Error: model lookup
    at useModel (/app/node_modules/@elizaos/core/dist/index.js:1:1)
    at doThing (/repo/plugins/my-plugin/src/index.ts:20:5)`),
		).toEqual({ caller: "my-plugin", callerStack: ["my-plugin"] });
	});

	it("still credits an installed @elizaos plugin package", () => {
		expect(
			trace(`Error: model lookup
${CORE_FRAME}
    at helper (/app/node_modules/@elizaos/plugin-x/dist/index.js:1:1)`),
		).toEqual({ caller: "plugin-x", callerStack: ["plugin-x"] });
	});
});
