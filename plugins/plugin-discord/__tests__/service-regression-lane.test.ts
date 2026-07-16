/**
 * Composes the DiscordService-focused suites for changes to the monolithic
 * `service.ts`. The changed-file coverage gate runs only tests present in a PR
 * diff, so this lane keeps service changes attached to the existing behavioral
 * matrix until the service is decomposed into independently covered modules.
 * Mirrors `packages/core/src/__tests__/runtime-regression-lane.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./channel-allowlist.test.ts";
import "./connector-rooms.test.ts";
import "./list-servers-persisted-world.test.ts";
import "./login-retry.test.ts";
import "./owner-refresh.test.ts";
import "./register-slash-commands-guards.test.ts";
import "./service-account-config-resolution.test.ts";
import "./service-account-pool.test.ts";
import "./slash-command-registration-scope.test.ts";
import "./thread-target-parent-mute.test.ts";

describe("service regression lane composition", () => {
	it("imports every default-lane suite that exercises ../service", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
		const imported = [...selfSource.matchAll(/import "\.\/([^"]+)";/g)]
			.map((match) => match[1])
			.sort();
		const serviceSuites = readdirSync(here)
			.filter(
				(name) =>
					name.endsWith(".test.ts") &&
					!name.endsWith(".harness.test.ts") &&
					name !== path.basename(fileURLToPath(import.meta.url)) &&
					/from "\.\.\/service(\.ts)?"/.test(
						readFileSync(path.join(here, name), "utf8"),
					),
			)
			.sort();
		expect(imported).toEqual(serviceSuites);
	});
});
