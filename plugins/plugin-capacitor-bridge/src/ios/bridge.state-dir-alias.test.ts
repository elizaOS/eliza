/**
 * Alias-aware ELIZA_STATE_DIR resolution for the iOS bridge (#13422). Drives the
 * real `resolveMobileStateDir` against an iOS bridge boot state without a
 * preloaded alias table and the real `process.env` — no mocks — proving
 * brand→eliza resolution, canonical precedence, empty-is-unset, and no
 * ELIZA_* mirror write.
 */

import {
	getBootConfig,
	setBootConfig,
} from "@elizaos/shared/config/boot-config-store";
import { readAliasedEnv } from "@elizaos/shared/utils/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMobileStateDir } from "./bridge.ts";

const TOUCHED_KEYS = [
	"ACME_STATE_DIR",
	"MILADY_STATE_DIR",
	"ELIZA_STATE_DIR",
	"ELIZA_HOME",
	"ELIZA_WORKSPACE_DIR",
] as const;

describe("iOS bridge ELIZA_STATE_DIR alias resolution", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedBootConfig: ReturnType<typeof getBootConfig>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of TOUCHED_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		savedBootConfig = getBootConfig();
		setBootConfig({
			...savedBootConfig,
			envAliases: undefined,
		});
	});

	afterEach(() => {
		for (const key of TOUCHED_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		setBootConfig(savedBootConfig);
	});

	it("resolves the MILADY brand prefix through the alias-aware reader", () => {
		process.env.MILADY_STATE_DIR = "/data/milady/state";
		expect(resolveMobileStateDir()).toBe("/data/milady/state");
		expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/data/milady/state");
		expect(getBootConfig().envAliases).toContainEqual([
			"MILADY_STATE_DIR",
			"ELIZA_STATE_DIR",
		]);
	});

	it("seeds aliases for a branded prefix present in the bridge environment", () => {
		process.env.ACME_STATE_DIR = "/data/acme/state";
		expect(resolveMobileStateDir()).toBe("/data/acme/state");
		expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/data/acme/state");
		expect(getBootConfig().envAliases).toContainEqual([
			"ACME_STATE_DIR",
			"ELIZA_STATE_DIR",
		]);
	});

	it("prefers the canonical ELIZA_STATE_DIR over the brand alias", () => {
		process.env.ELIZA_STATE_DIR = "/canonical/state";
		process.env.MILADY_STATE_DIR = "/data/milady/state";
		expect(resolveMobileStateDir()).toBe("/canonical/state");
	});

	it("treats a blank canonical value as unset and falls back to the brand alias", () => {
		process.env.ELIZA_STATE_DIR = "   ";
		process.env.MILADY_STATE_DIR = "/data/milady/state";
		expect(resolveMobileStateDir()).toBe("/data/milady/state");
	});

	it("does not mirror-write the resolved brand value back to ELIZA_STATE_DIR", () => {
		process.env.MILADY_STATE_DIR = "/data/milady/state";
		resolveMobileStateDir();
		expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
	});
});
