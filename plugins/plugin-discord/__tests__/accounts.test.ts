import { describe, expect, it } from "vitest";
import {
	isMultiAccountEnabled,
	listDiscordAccountIds,
	listEnabledDiscordAccounts,
	normalizeAccountId,
	normalizeDiscordToken,
	resolveDiscordAccount,
	resolveDiscordToken,
} from "../accounts";

interface RuntimeLike {
	character?: { settings?: { discord?: Record<string, unknown> } };
	getSetting(key: string): string | undefined;
}

function makeRuntime(
	discord: Record<string, unknown> | undefined,
	settings: Record<string, string | undefined> = {},
): RuntimeLike {
	return {
		character: discord === undefined ? undefined : { settings: { discord } },
		getSetting: (key: string) => settings[key],
	};
}

describe("discord accounts: normalizeAccountId", () => {
	it("falls back to the default id for missing/empty/non-string values", () => {
		expect(normalizeAccountId()).toBe("default");
		expect(normalizeAccountId(null)).toBe("default");
		expect(normalizeAccountId(undefined)).toBe("default");
		expect(normalizeAccountId("")).toBe("default");
		expect(normalizeAccountId("   ")).toBe("default");
		expect(normalizeAccountId(42 as unknown as string)).toBe("default");
	});

	it("trims and lowercases real account ids", () => {
		expect(normalizeAccountId("  MyAcct ")).toBe("myacct");
		expect(normalizeAccountId("Alpha")).toBe("alpha");
	});
});

describe("discord accounts: normalizeDiscordToken", () => {
	it("strips a Bot/ bot prefix case-insensitively", () => {
		expect(normalizeDiscordToken("Bot abc.def.ghi")).toBe("abc.def.ghi");
		expect(normalizeDiscordToken("bot abc.def.ghi")).toBe("abc.def.ghi");
		expect(normalizeDiscordToken("  Bot  abc.def.ghi  ")).toBe("abc.def.ghi");
	});

	it("does NOT strip a prefix that is not followed by whitespace", () => {
		expect(normalizeDiscordToken("Botabc.def")).toBe("Botabc.def");
	});

	it("returns undefined for missing/blank tokens", () => {
		expect(normalizeDiscordToken()).toBeUndefined();
		expect(normalizeDiscordToken(null)).toBeUndefined();
		expect(normalizeDiscordToken("")).toBeUndefined();
		expect(normalizeDiscordToken("   ")).toBeUndefined();
	});
});

describe("discord accounts: resolveDiscordToken precedence and account isolation", () => {
	it("account-specific token wins over base and env tokens", () => {
		const rt = makeRuntime(
			{ accounts: { alt: { token: "Bot acct-tok" } }, token: "base-tok" },
			{ DISCORD_API_TOKEN: "env-tok" },
		);
		expect(resolveDiscordToken(rt, { accountId: "alt" })).toEqual({
			token: "acct-tok",
			source: "config",
		});
	});

	it("a non-default account NEVER falls back to base or env tokens", () => {
		// Credential isolation: without its own token a non-default account must
		// resolve to `none`, never silently reuse the base/env credential.
		const rt = makeRuntime(
			{ token: "base-tok" },
			{ DISCORD_API_TOKEN: "env-tok" },
		);
		expect(resolveDiscordToken(rt, { accountId: "alt" })).toEqual({
			token: "",
			source: "none",
		});
	});

	it("default account precedence: account config > character > env > none", () => {
		const withAccount = makeRuntime({
			accounts: { default: { token: "acc" } },
		});
		expect(resolveDiscordToken(withAccount, {})).toEqual({
			token: "acc",
			source: "config",
		});

		const withBase = makeRuntime(
			{ token: "char-tok" },
			{ DISCORD_API_TOKEN: "env-tok" },
		);
		expect(resolveDiscordToken(withBase, {})).toEqual({
			token: "char-tok",
			source: "character",
		});

		const withEnv = makeRuntime({}, { DISCORD_API_TOKEN: "env-tok" });
		expect(resolveDiscordToken(withEnv, {})).toEqual({
			token: "env-tok",
			source: "env",
		});

		const withNothing = makeRuntime({});
		expect(resolveDiscordToken(withNothing, {})).toEqual({
			token: "",
			source: "none",
		});
	});
});

describe("discord accounts: enabled gating", () => {
	it("base-level enabled:false disables every account", () => {
		const rt = makeRuntime({ enabled: false, token: "tok" });
		expect(resolveDiscordAccount(rt, "default").enabled).toBe(false);
	});

	it("account-level enabled:false disables that account only", () => {
		const rt = makeRuntime({
			accounts: { a: { enabled: false, token: "a-tok" } },
			token: "base-tok",
		});
		expect(resolveDiscordAccount(rt, "a").enabled).toBe(false);
	});

	it("an account with no token is filtered out even when the base token exists", () => {
		// Non-default accounts cannot borrow the base token (isolation), so an
		// account configured without its own token is never enabled.
		const rt = makeRuntime({
			accounts: { a: { enabled: true } },
			token: "base-tok",
		});
		const enabled = listEnabledDiscordAccounts(rt);
		expect(enabled.map((a) => a.accountId)).toEqual([]);
	});
});

describe("discord accounts: listDiscordAccountIds", () => {
	it("returns the default id when no accounts are configured", () => {
		expect(listDiscordAccountIds(makeRuntime({}))).toEqual(["default"]);
	});

	it("sorts configured account ids deterministically", () => {
		const rt = makeRuntime({ accounts: { zebra: {}, alpha: {} } });
		expect(listDiscordAccountIds(rt)).toEqual(["alpha", "zebra"]);
	});
});

describe("discord accounts: boolean env parsing", () => {
	it("parses true/1/false/0 and drops garbage values", () => {
		const rt = makeRuntime(
			{ token: "tok" },
			{
				DISCORD_SHOULD_IGNORE_BOT_MESSAGES: "true",
				DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "1",
				DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "garbage",
			},
		);
		const acct = resolveDiscordAccount(rt, "default");
		expect(acct.config.shouldIgnoreBotMessages).toBe(true);
		expect(acct.config.shouldIgnoreDirectMessages).toBe(true);
		expect(acct.config.shouldRespondOnlyToMentions).toBeUndefined();
	});

	it("false/0 parse to false rather than undefined", () => {
		const rt = makeRuntime(
			{ token: "tok" },
			{ DISCORD_SHOULD_IGNORE_BOT_MESSAGES: "0" },
		);
		const acct = resolveDiscordAccount(rt, "default");
		expect(acct.config.shouldIgnoreBotMessages).toBe(false);
	});
});

describe("discord accounts: multi-account detection", () => {
	it("is multi-account only when more than one account is enabled with a token", () => {
		expect(
			isMultiAccountEnabled(
				makeRuntime({ accounts: { a: { token: "t1" }, b: { token: "t2" } } }),
			),
		).toBe(true);
		expect(
			isMultiAccountEnabled(makeRuntime({ accounts: { a: { token: "t1" } } })),
		).toBe(false);
		expect(isMultiAccountEnabled(makeRuntime({}))).toBe(false);
	});
});
