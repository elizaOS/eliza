/**
 * Composes the MessageManager-focused suites for changes to the monolithic
 * `messages.ts` (the inbound `handleMessage` path). The changed-file coverage
 * gate runs only tests present in a PR diff, so this lane keeps message-handler
 * changes attached to the existing behavioral matrix until the handler is
 * decomposed into independently covered units. Mirrors the core and discord
 * service regression lanes.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./dm-gate-handle-message.test.ts";
import "./dm-policy.test.ts";
import "./dm-widget-components.test.ts";
import "./generation-abort.test.ts";
import "./generation-timeout-dispatch.test.ts";
import "./generation-timeout.test.ts";
import "./messages-component-delivery.test.ts";
import "./messages-url.test.ts";
import "./numeric-fact-dedup.test.ts";

describe("messages regression lane composition", () => {
	it("imports every default-lane suite that drives ../messages", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
		const imported = [...selfSource.matchAll(/import "\.\/([^"]+)";/g)]
			.map((match) => match[1])
			.sort();
		const suites = readdirSync(here)
			.filter(
				(name) =>
					name.endsWith(".test.ts") &&
					!name.endsWith(".harness.test.ts") &&
					name !== path.basename(fileURLToPath(import.meta.url)) &&
					// Static or dynamic reference to the module under test, with or
					// without the `.ts` extension (`from "../messages"`,
					// `from "../messages.ts"`, `import("../messages")`).
					/["'(]\.\.\/messages(?:\.ts)?["')]/.test(
						readFileSync(path.join(here, name), "utf8"),
					),
			)
			.sort();
		expect(imported).toEqual(suites);
	});
});
