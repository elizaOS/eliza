/**
 * Verifies resolveProviderContexts (context-catalog) surfaces the ACTION_STATE
 * provider in every first-party context, and guards the action-context contract:
 * declared `action.contexts` wins over the LEGACY_ACTION_CONTEXT_FALLBACK table,
 * and no core-owned action that declares its own contexts leaks back into the
 * legacy fallback (#12090 item 35 drift guard). Vitest, direct function calls.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { actionStateProvider } from "../features/basic-capabilities/providers/actionState";
import { FIRST_PARTY_CONTEXT_IDS } from "../runtime/context-normalization";
import type { Action, AgentContext } from "../types/components";
import * as contextCatalog from "./context-catalog";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeAction(name: string, contexts?: AgentContext[]): Action {
	return { name, contexts } as unknown as Action;
}

/**
 * Core-owned actions that used to depend on the static fallback table and now
 * declare `contexts` on their own definition. Each row is the action NAME and the
 * source file whose action object must carry a `contexts:` declaration.
 */
const MIGRATED_CORE_ACTIONS: ReadonlyArray<{ name: string; file: string }> = [
	{
		name: "ATTACHMENT",
		file: "../features/working-memory/readAttachmentAction.ts",
	},
	{ name: "DOCUMENT", file: "../features/documents/actions.ts" },
	{
		name: "GENERATE_MEDIA",
		file: "../features/advanced-capabilities/actions/generateMedia.ts",
	},
	{
		name: "MESSAGE",
		file: "../features/advanced-capabilities/actions/message.ts",
	},
	{ name: "POST", file: "../features/advanced-capabilities/actions/post.ts" },
	{
		name: "MANAGE_PLUGINS",
		file: "../features/plugin-manager/actions/plugin.ts",
	},
	{ name: "PAYMENT", file: "../features/payments/actions/payment.ts" },
];

describe("resolveActionContexts", () => {
	it("prefers an action's declared contexts over the legacy fallback", () => {
		// NONE has a legacy fallback of ["general"]; a declared array must win.
		expect(
			contextCatalog.resolveActionContexts(
				makeAction("NONE", ["wallet", "code"]),
			),
		).toEqual(["wallet", "code"]);
	});

	it("falls back to the legacy table for plugin-owned names without declared contexts", () => {
		// SEND_TOKEN is a plugin-owned (third-party) action name kept in the fallback.
		expect(
			contextCatalog.resolveActionContexts(makeAction("SEND_TOKEN")),
		).toEqual(["wallet"]);
		expect(
			contextCatalog.resolveActionContexts(makeAction("send_token")),
		).toEqual(["wallet"]);
	});

	it('defaults unknown, undeclared action names to ["general"]', () => {
		expect(
			contextCatalog.resolveActionContexts(
				makeAction("TOTALLY_UNKNOWN_ACTION"),
			),
		).toEqual(["general"]);
	});

	it("treats an empty declared contexts array as undeclared (falls through)", () => {
		expect(
			contextCatalog.resolveActionContexts(makeAction("REPLY", [])),
		).toEqual(["general"]);
	});
});

describe("LEGACY_ACTION_CONTEXT_FALLBACK drift guard (#12090 item 35)", () => {
	it("does not keep any migrated core-owned action name as a key", () => {
		for (const { name } of MIGRATED_CORE_ACTIONS) {
			expect(
				Object.hasOwn(contextCatalog.LEGACY_ACTION_CONTEXT_FALLBACK, name),
			).toBe(false);
		}
	});

	it("proves each migrated core action declares contexts on its own definition", () => {
		for (const { name, file } of MIGRATED_CORE_ACTIONS) {
			const src = readFileSync(resolve(__dirname, file), "utf8");
			// The action object must carry a `contexts:` declaration; without it the
			// action would silently fall back to ["general"] now that the static
			// entry is gone. This is the executable-path guard for the coupling.
			expect(src, `${name} (${file}) must declare contexts`).toMatch(
				/\bcontexts:\s*(\[|[A-Z_]+_CONTEXTS)/,
			);
		}
	});

	it("only retains uppercase action-name keys (legacy fallback shape)", () => {
		for (const key of Object.keys(
			contextCatalog.LEGACY_ACTION_CONTEXT_FALLBACK,
		)) {
			expect(key, `${key} should be an UPPER_SNAKE action name`).toMatch(
				/^[A-Z][A-Z0-9_]*$/,
			);
		}
	});
});

describe("resolveProviderContexts", () => {
	it("exposes ACTION_STATE in every first-party context", () => {
		expect(contextCatalog.resolveProviderContexts(actionStateProvider)).toEqual(
			[...FIRST_PARTY_CONTEXT_IDS],
		);
		expect(
			contextCatalog.resolveProviderContexts(actionStateProvider),
		).toContain("tasks");
		expect(
			contextCatalog.resolveProviderContexts(actionStateProvider),
		).toContain("code");
		expect(
			contextCatalog.resolveProviderContexts(actionStateProvider),
		).toContain("agent_internal");
	});
});
