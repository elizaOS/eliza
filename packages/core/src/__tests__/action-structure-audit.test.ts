import { describe, expect, it } from "vitest";
import { secretsAction } from "../features/secrets/actions/manage-secret.ts";
import { trustAction } from "../features/trust/actions/trust.ts";
import { allActionDocs } from "../generated/action-docs.ts";

const RETIRED_GENERATED_ACTION_NAMES = [
	"ASK_USER_QUESTION",
	"CHECKIN",
	"CLEAR_HISTORY",
	"CREATE_PLAN",
	"CREATE_PAYMENT_REQUEST",
	"DESKTOP",
	"DEVICE_FILE_READ",
	"DEVICE_FILE_WRITE",
	"DEVICE_LIST_DIR",
	"DISCORD_SETUP_CREDENTIALS",
	"DOC",
	"ENTER_WORKTREE",
	"EXIT_WORKTREE",
	"DELIVER_PAYMENT_LINK",
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
	"MYSTICISM_PAYMENT",
	"VERIFY_PAYMENT_PAYLOAD",
	"SETTLE_PAYMENT",
	"AWAIT_PAYMENT_CALLBACK",
	"CANCEL_PAYMENT_REQUEST",
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
	// Suno music generation absorbed into the MUSIC umbrella with
	// action=generate|extend|custom_generate. The plugin-suno package still
	// ships the SunoProvider client and status provider, but no longer
	// registers MUSIC_GENERATION as a top-level Action.
	"MUSIC_GENERATION",
	// Page-group umbrella parents collapsed into the single PAGE_DELEGATE
	// owner-only parent in packages/agent/src/actions/page-action-groups.ts.
	"BROWSER_ACTIONS",
	"WALLET_ACTIONS",
	"CHARACTER_ACTIONS",
	"SETTINGS_ACTIONS",
	"CONNECTOR_ACTIONS",
	"AUTOMATION_ACTIONS",
	"PHONE_ACTIONS",
	"OWNER_ACTIONS",
	// Dead agent actions deleted from packages/agent/src/actions/. ANALYZE_IMAGE
	// (media.ts), EXTRACT_PAGE (extract-page.ts), QUERY_TRAJECTORIES
	// (trajectories.ts), and SKILL_COMMAND (skill-command.ts) were exported but
	// never registered in eliza-plugin.ts. Their source files have been
	// removed; SKILL_COMMAND callers should route through USE_SKILL.
	"ANALYZE_IMAGE",
	"EXTRACT_PAGE",
	"QUERY_TRAJECTORIES",
	"SKILL_COMMAND",
] as const;

/**
 * Canonical replacement for the eight retired per-page `<PAGE>_ACTIONS`
 * umbrellas. PAGE_DELEGATE lives in packages/agent and cannot be imported from
 * this core test (core does not depend on agent), so the structural guard is
 * twofold: PAGE_DELEGATE must not appear in the retired list above, and every
 * page name it replaces must.
 */
const PAGE_DELEGATE_REPLACES = [
	"BROWSER_ACTIONS",
	"WALLET_ACTIONS",
	"CHARACTER_ACTIONS",
	"SETTINGS_ACTIONS",
	"CONNECTOR_ACTIONS",
	"AUTOMATION_ACTIONS",
	"PHONE_ACTIONS",
	"OWNER_ACTIONS",
] as const;

const REQUIRED_OWNER_SURFACE_ACTION_NAMES = [
	"SCHEDULED_TASKS",
	"CREDENTIALS",
	"PERSONAL_ASSISTANT",
	"OWNER_DOCUMENTS",
	"PAYMENT",
	"FILE",
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

	it("keeps canonical owner surfaces present in generated canonical docs", () => {
		const names = new Set(allActionDocs.map((action) => action.name));
		const retired = new Set<string>(RETIRED_GENERATED_ACTION_NAMES);
		for (const name of REQUIRED_OWNER_SURFACE_ACTION_NAMES) {
			expect(retired.has(name), `${name} must not be marked retired`).toBe(
				false,
			);
			expect(names.has(name), `${name} must be generated`).toBe(true);
		}
		expect(retired.has("PAYMENT"), "PAYMENT is not a retired parent").toBe(
			false,
		);
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

	it("PAGE_DELEGATE replaces the eight per-page _ACTIONS umbrellas", () => {
		const retired = new Set<string>(RETIRED_GENERATED_ACTION_NAMES);
		expect(
			retired.has("PAGE_DELEGATE"),
			"PAGE_DELEGATE is the canonical replacement and must not be marked retired",
		).toBe(false);
		for (const legacy of PAGE_DELEGATE_REPLACES) {
			expect(
				retired.has(legacy),
				`${legacy} must be retired in favor of PAGE_DELEGATE`,
			).toBe(true);
		}
		const names = new Set(allActionDocs.map((action) => action.name));
		for (const legacy of PAGE_DELEGATE_REPLACES) {
			expect(
				names.has(legacy),
				`${legacy} must not appear in canonical docs`,
			).toBe(false);
		}
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
