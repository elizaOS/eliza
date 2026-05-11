import { describe, expect, it } from "vitest";
import { allActionDocs } from "../generated/action-docs.ts";

const RETIRED_GENERATED_ACTION_NAMES = [
	"ASK_USER_QUESTION",
	"CHECKIN",
	"DESKTOP",
	"DISCORD_SETUP_CREDENTIALS",
	"ENTER_WORKTREE",
	"EXIT_WORKTREE",
	"FIRST_RUN",
	"FORM_RESTORE",
	"LIFE",
	"PROFILE",
	"RELATIONSHIP",
	"MONEY",
	"PAYMENTS",
	"SUBSCRIPTIONS",
	"SCHEDULE",
	"BOOK_TRAVEL",
	"SCHEDULING_NEGOTIATION",
	"DEVICE_INTENT",
	"MESSAGE_HANDOFF",
	"APP_BLOCK",
	"WEBSITE_BLOCK",
	"AUTOFILL",
	"PASSWORD_MANAGER",
	"GOOGLE_CALENDAR",
	"NOSTR_PUBLISH_PROFILE",
	"PAYMENT",
	"PLACE_CALL",
	"READ_ATTACHMENT",
	"SHELL_COMMAND",
	"START_TUNNEL",
	"STOP_TUNNEL",
	"GET_TUNNEL_STATUS",
	"TAILSCALE",
	"READ",
	"WRITE",
	"EDIT",
	"GREP",
	"GLOB",
	"LS",
	"WEB_FETCH",
	"CREATE_TODO",
	"COMPLETE_TODO",
	"LIST_TODOS",
	"EDIT_TODO",
	"DELETE_TODO",
] as const;

const LEGACY_DISCRIMINATORS = new Set([
	"subaction",
	"op",
	"operation",
	"verb",
	"subAction",
	"__subaction",
]);

describe("action structure audit guards", () => {
	it("keeps retired action names out of generated canonical docs", () => {
		const names = new Set(allActionDocs.map((action) => action.name));
		for (const retired of RETIRED_GENERATED_ACTION_NAMES) {
			expect(names.has(retired), retired).toBe(false);
		}
	});

	it("requires schemas with legacy discriminator aliases to expose action", () => {
		const failures: string[] = [];
		for (const action of allActionDocs) {
			const parameterNames = new Set(
				(action.parameters ?? []).map((parameter) => parameter.name),
			);
			const hasLegacy = [...parameterNames].some((name) =>
				LEGACY_DISCRIMINATORS.has(name),
			);
			if (hasLegacy && !parameterNames.has("action")) {
				failures.push(action.name);
			}
		}
		expect(failures).toEqual([]);
	});
});
