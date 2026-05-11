import { describe, expect, it } from "vitest";
import { secretsAction } from "../features/secrets/actions/manage-secret.ts";
import { trustAction } from "../features/trust/actions/trust.ts";
import { allActionDocs } from "../generated/action-docs.ts";

const RETIRED_GENERATED_ACTION_NAMES = [
	"ASK_USER_QUESTION",
	"CHECKIN",
	"CLEAR_HISTORY",
	"CREATE_PLAN",
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
	"READING",
	"SCHEDULE",
	"BOOK_TRAVEL",
	"SCHEDULING_NEGOTIATION",
	"SEND_TO_ADMIN",
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
	"TOKEN_INFO",
	"BIRDEYE_SEARCH",
	// Trust leaves consolidated under the single TRUST umbrella with
	// action=evaluate|record_interaction|request_elevation|update_role.
	"EVALUATE_TRUST",
	"RECORD_TRUST_INTERACTION",
	"REQUEST_ELEVATION",
	"TRUST_UPDATE_ROLE",
	// Secrets leaves consolidated under the single SECRETS umbrella with
	// action=get|set|delete|list|check|mirror|request. The previous
	// top-level MANAGE_SECRET / SET_SECRET / atomic leaves are gone — the
	// planner sees only SECRETS plus its promoted virtuals (SECRETS_GET,
	// SECRETS_SET, ...) and the separate SECRETS_UPDATE_SETTINGS.
	"MANAGE_SECRET",
	"SET_SECRET",
	"GET_SECRET",
	"LIST_SECRETS",
	"CHECK_SECRET",
	"DELETE_SECRET",
	"MIRROR_SECRET_TO_VAULT",
	"REQUEST_SECRET",
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

	it("TRUST umbrella uses canonical action discriminator with all subactions", () => {
		expect(trustAction.name).toBe("TRUST");
		const discriminator = (trustAction.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(
			discriminator,
			"TRUST must declare an `action` parameter",
		).toBeDefined();
		const schema = discriminator?.schema as { enum?: string[] } | undefined;
		expect(schema?.enum).toBeDefined();
		expect(new Set(schema?.enum ?? [])).toEqual(
			new Set([
				"evaluate",
				"record_interaction",
				"request_elevation",
				"update_role",
			]),
		);
	});

	it("SECRETS umbrella uses canonical action discriminator with all subactions", () => {
		expect(secretsAction.name).toBe("SECRETS");
		const discriminator = (secretsAction.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(
			discriminator,
			"SECRETS must declare an `action` parameter",
		).toBeDefined();
		const schema = discriminator?.schema as { enum?: string[] } | undefined;
		expect(schema?.enum).toBeDefined();
		expect(new Set(schema?.enum ?? [])).toEqual(
			new Set(["get", "set", "delete", "list", "check", "mirror", "request"]),
		);
	});
});
