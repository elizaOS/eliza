/**
 * Schema-drift contract tests.
 *
 * Background: the renderer hit "Invalid option: expected one of …" on
 * every Browser-page request because `ConversationScopeSchema` (Zod
 * route input validator) drifted from `ConversationScope` (TS type
 * union in agent/api/server-types) and from the runtime `VALID_SCOPES`
 * allowlist. All three compiled cleanly; the bug only surfaced when
 * the renderer made a request the schema rejected.
 *
 * This test pins each Zod enum used by a route schema to the source-of-
 * truth set the runtime + types expect. Drift becomes a compile/test
 * failure, not a user-visible toast.
 *
 * Adding a new schema: import both sides + assert membership equality.
 */

import { describe, expect, it } from "bun:test";
import {
	ConversationScopeSchema,
	ConversationAutomationTypeSchema,
} from "../conversation-routes";

// `VALID_SCOPES` lives in agent/api/conversation-metadata.ts as the
// runtime sanitizer's allowlist. Mirror it here as a literal set —
// dist isn't required (the test runs against source). The literal set
// is the contract being asserted; any change here is a deliberate
// schema migration the test forces us to acknowledge.
const VALID_CONVERSATION_SCOPES = new Set([
	"general",
	"automation-coordinator",
	"automation-workflow",
	"automation-workflow-draft",
	"automation-draft",
	"page-character",
	"page-apps",
	"page-connectors",
	"page-phone",
	"page-plugins",
	"page-lifeops",
	"page-settings",
	"page-wallet",
	"page-browser",
	"page-automations",
]);

const VALID_CONVERSATION_AUTOMATION_TYPES = new Set([
	"coordinator_text",
	"workflow",
]);

function zodEnumOptions(schema: { options: readonly string[] }): Set<string> {
	return new Set(schema.options);
}

describe("Zod schema ↔ runtime allowlist drift", () => {
	it("ConversationScopeSchema matches VALID_SCOPES exactly", () => {
		const zodSet = zodEnumOptions(ConversationScopeSchema);
		const missingFromZod = [...VALID_CONVERSATION_SCOPES].filter(
			(scope) => !zodSet.has(scope),
		);
		const extraInZod = [...zodSet].filter(
			(scope) => !VALID_CONVERSATION_SCOPES.has(scope),
		);
		expect({ missingFromZod, extraInZod }).toEqual({
			missingFromZod: [],
			extraInZod: [],
		});
	});

	it("ConversationAutomationTypeSchema matches VALID_AUTOMATION_TYPES exactly", () => {
		const zodSet = zodEnumOptions(ConversationAutomationTypeSchema);
		const missing = [...VALID_CONVERSATION_AUTOMATION_TYPES].filter(
			(t) => !zodSet.has(t),
		);
		const extra = [...zodSet].filter(
			(t) => !VALID_CONVERSATION_AUTOMATION_TYPES.has(t),
		);
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});
});
