/**
 * Android /data/data ↔ /data/user/0 alias handling in the mobile fs sandbox.
 * The pure mapper is exercised in-process; the shim's accept/reject behavior
 * is proven against the REAL installMobileFsShim in a Bun subprocess (the
 * shim patches node:fs process-wide, so installing it inside the test runner
 * would sandbox vitest itself). Regression for the on-device boot death where
 * an alias-spelled ELIZA_STATE_DIR was rejected against a canonical root and
 * the agent died at startEliza before it could even write diagnostics.
 */

import { execFileSync } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { androidAliasSibling } from "./fs-shim.ts";

const SHIM_PATH = nodePath.resolve(
	nodePath.dirname(fileURLToPath(import.meta.url)),
	"fs-shim.ts",
);

describe("androidAliasSibling", () => {
	it("maps /data/data/<pkg> to /data/user/0/<pkg> and back", () => {
		expect(androidAliasSibling("/data/data/ai.elizaos.app")).toBe(
			"/data/user/0/ai.elizaos.app",
		);
		expect(androidAliasSibling("/data/user/0/ai.elizaos.app")).toBe(
			"/data/data/ai.elizaos.app",
		);
	});

	it("preserves the path suffix under the package dir", () => {
		expect(
			androidAliasSibling("/data/data/ai.elizaos.app/files/eliza/eliza.json"),
		).toBe("/data/user/0/ai.elizaos.app/files/eliza/eliza.json");
		expect(androidAliasSibling("/data/user/0/pkg.x/files")).toBe(
			"/data/data/pkg.x/files",
		);
	});

	it("returns null for non-aliased paths", () => {
		// Secondary Android users are NOT the /data/data alias — only user 0.
		expect(androidAliasSibling("/data/user/10/ai.elizaos.app")).toBeNull();
		expect(androidAliasSibling("/data/local/tmp/.eliza")).toBeNull();
		expect(androidAliasSibling("/var/mobile/Containers/x")).toBeNull();
		expect(androidAliasSibling("/data/data")).toBeNull();
	});

	it("does not treat sibling-prefixed package names as aliases of each other", () => {
		expect(androidAliasSibling("/data/data/pkg")).toBe("/data/user/0/pkg");
		// A path like /data/data/pkg-evil must map only to its own name.
		expect(androidAliasSibling("/data/data/pkg-evil/x")).toBe(
			"/data/user/0/pkg-evil/x",
		);
	});
});

describe("installMobileFsShim alias acceptance (real shim, Bun subprocess)", () => {
	it("accepts the alias spelling of the workspace root and still blocks escapes", () => {
		const script = [
			`const { installMobileFsShim, sandboxedPath } = await import(${JSON.stringify(SHIM_PATH)});`,
			`installMobileFsShim("/data/user/0/test.alias.pkg/files");`,
			`const out = { aliasAccepted: false, canonicalAccepted: false, escapeBlocked: false, otherPkgBlocked: false };`,
			`try { sandboxedPath("/data/data/test.alias.pkg/files/eliza/eliza.json"); out.aliasAccepted = true; } catch {}`,
			`try { sandboxedPath("/data/user/0/test.alias.pkg/files/agent/agent-bundle.js"); out.canonicalAccepted = true; } catch {}`,
			`try { sandboxedPath("/data/user/0/test.alias.pkg/files-escape/x"); } catch { out.escapeBlocked = true; }`,
			`try { sandboxedPath("/data/data/other.pkg/files/x"); } catch { out.otherPkgBlocked = true; }`,
			`console.log(JSON.stringify(out));`,
		].join("\n");
		const stdout = execFileSync("bun", ["-e", script], {
			encoding: "utf8",
			timeout: 30_000,
		});
		const lastLine = stdout.trim().split("\n").at(-1) ?? "";
		const result = JSON.parse(lastLine) as Record<string, boolean>;
		expect(result).toEqual({
			aliasAccepted: true,
			canonicalAccepted: true,
			escapeBlocked: true,
			otherPkgBlocked: true,
		});
	});
});
