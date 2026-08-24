/**
 * Deterministic unit tests for the setup config helpers in
 * features/secrets/setup/config: createSetupConfig's fallback/override
 * precedence over COMMON_API_KEY_SETTINGS, the unconfigured/complete
 * filters' strict null-value semantics, getNextSetting's dependency and
 * visibility gating with optional fallback, and generateSettingPrompt
 * composition. Pure module under test — no mocks, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
	COMMON_API_KEY_SETTINGS,
	createSetupConfig,
	DEFAULT_SETUP_MESSAGES,
	generateSettingPrompt,
	getNextSetting,
	getUnconfiguredOptional,
	getUnconfiguredRequired,
	isSetupComplete,
	type SetupConfig,
	type SetupSetting,
} from "./config.ts";

function setting(name: string, over: Partial<SetupSetting> = {}): SetupSetting {
	return {
		name,
		description: `${name} description`,
		secret: true,
		public: false,
		required: true,
		dependsOn: [],
		value: null,
		...over,
	};
}

describe("createSetupConfig", () => {
	it("applies key-based fallbacks for a required key unknown to the catalog", () => {
		const config = createSetupConfig(["MY_SERVICE_TOKEN"]);
		expect(Object.keys(config.settings)).toEqual(["MY_SERVICE_TOKEN"]);

		const s = config.settings.MY_SERVICE_TOKEN;
		expect(s.name).toBe("MY_SERVICE_TOKEN");
		expect(s.description).toBe("Configure MY_SERVICE_TOKEN");
		expect(s.usageDescription).toBeUndefined();
		expect(s.secret).toBe(true);
		expect(s.public).toBe(false);
		expect(s.required).toBe(true);
		expect(s.dependsOn).toEqual([]);
		expect(s.validationMethod).toBeUndefined();
		expect(s.type).toBe("api_key");
		expect(s.envVar).toBe("MY_SERVICE_TOKEN");
		expect(s.value).toBeNull();
	});

	it("marks keys passed as optionalKeys with required false and the same defaults", () => {
		const config = createSetupConfig([], ["OPTIONAL_EXTRA"]);
		const s = config.settings.OPTIONAL_EXTRA;
		expect(s.required).toBe(false);
		expect(s.secret).toBe(true);
		expect(s.type).toBe("api_key");
		expect(s.envVar).toBe("OPTIONAL_EXTRA");
	});

	it("forces required true even when the catalog entry is marked optional", () => {
		// OPENAI_API_KEY ships in COMMON_API_KEY_SETTINGS with required: false;
		// passing it through requiredKeys must still produce required: true.
		expect(COMMON_API_KEY_SETTINGS.OPENAI_API_KEY?.required).toBe(false);
		const config = createSetupConfig(["OPENAI_API_KEY"]);
		expect(config.settings.OPENAI_API_KEY.required).toBe(true);
		expect(config.settings.OPENAI_API_KEY.validationMethod).toBe("openai");
		expect(config.settings.OPENAI_API_KEY.envVar).toBe("OPENAI_API_KEY");
		expect(config.settings.OPENAI_API_KEY.usageDescription).toBeTruthy();
	});

	it("lets custom settings win over catalog entries for overlapping fields", () => {
		const config = createSetupConfig(["OPENAI_API_KEY"], [], {
			OPENAI_API_KEY: {
				name: "Custom OpenAI Key",
				envVar: "MY_OPENAI_ENV",
				secret: false,
			},
		});
		const s = config.settings.OPENAI_API_KEY;
		expect(s.name).toBe("Custom OpenAI Key");
		expect(s.envVar).toBe("MY_OPENAI_ENV");
		expect(s.secret).toBe(false);
		// Fields the custom entry does not mention keep their catalog values.
		expect(s.validationMethod).toBe("openai");
		expect(s.public).toBe(false);
	});

	it("preserves catalog dependency chains but drops catalog function fields", () => {
		const config = createSetupConfig([
			"TWITTER_USERNAME",
			"TWITTER_PASSWORD",
			"TWITTER_EMAIL",
		]);
		expect(config.settings.TWITTER_PASSWORD.dependsOn).toEqual([
			"TWITTER_USERNAME",
		]);
		// Observed behavior: createSetupConfig copies only the scalar catalog
		// fields plus any custom overrides, so the catalog entry's validation
		// closure is NOT carried onto the built setting.
		expect(COMMON_API_KEY_SETTINGS.TWITTER_EMAIL?.validation).toBeTypeOf(
			"function",
		);
		expect(config.settings.TWITTER_EMAIL.validation).toBeUndefined();
	});

	it("keeps the catalog TWITTER_EMAIL validation delegating to the structural email check", () => {
		const validate = COMMON_API_KEY_SETTINGS.TWITTER_EMAIL?.validation;
		expect(validate?.("user@example.com")).toBe(true);
		expect(validate?.("not-an-email")).toBe(false);
	});

	it("returns an empty settings record for empty input", () => {
		expect(createSetupConfig([]).settings).toEqual({});
	});
});

describe("unconfigured getters and isSetupComplete", () => {
	function mixedConfig(): SetupConfig {
		return {
			settings: {
				requiredOpen: setting("Required Open"),
				requiredSet: setting("Required Set", { value: "sk-set" }),
				optionalOpen: setting("Optional Open", { required: false }),
				optionalSet: setting("Optional Set", {
					required: false,
					value: "",
				}),
			},
		};
	}

	it("lists only unconfigured required settings by strict null equality", () => {
		const open = getUnconfiguredRequired(mixedConfig());
		expect(open.map(([key]) => key)).toEqual(["requiredOpen"]);
	});

	it("treats an empty-string value as configured but null as unconfigured", () => {
		const config = mixedConfig();
		config.settings.requiredOpen.value = "";
		expect(getUnconfiguredRequired(config)).toEqual([]);
	});

	it("excludes a setting whose value is undefined from both getters", () => {
		// SetupSetting.value is optional; the filter compares against null
		// strictly, so a missing value reads as configured, not pending.
		const config: SetupConfig = {
			settings: {
				noValueField: setting("No Value Field"),
			},
		};
		delete (config.settings.noValueField as Partial<SetupSetting>).value;
		expect(getUnconfiguredRequired(config)).toEqual([]);
		expect(getUnconfiguredOptional(config)).toEqual([]);
	});

	it("splits unconfigured optionals into the optional getter only", () => {
		const optional = getUnconfiguredOptional(mixedConfig());
		expect(optional.map(([key]) => key)).toEqual(["optionalOpen"]);

		const required = getUnconfiguredRequired(mixedConfig());
		expect(required.map(([, s]) => s.required)).toEqual([true]);
	});

	it("reports completion ignoring unset optionals and requiring all required set", () => {
		expect(isSetupComplete({ settings: {} })).toBe(true);
		expect(isSetupComplete(mixedConfig())).toBe(false);

		const complete = mixedConfig();
		complete.settings.requiredOpen.value = "done";
		expect(isSetupComplete(complete)).toBe(true);
	});
});

describe("getNextSetting", () => {
	it("returns the first unconfigured required setting in insertion order", () => {
		const config: SetupConfig = {
			settings: {
				first: setting("First"),
				second: setting("Second"),
			},
		};
		expect(getNextSetting(config)?.[0]).toBe("first");

		config.settings.first.value = "x";
		expect(getNextSetting(config)?.[0]).toBe("second");
	});

	it("skips settings whose dependencies are not yet configured", () => {
		const config: SetupConfig = {
			settings: {
				password: setting("Password", {
					dependsOn: ["username"],
				}),
				username: setting("Username"),
			},
		};
		expect(getNextSetting(config)?.[0]).toBe("username");

		config.settings.username.value = "user";
		expect(getNextSetting(config)?.[0]).toBe("password");
	});

	it("blocks on a dependency that references a missing key", () => {
		const config: SetupConfig = {
			settings: {
				orphan: setting("Orphan", { dependsOn: ["ghost"] }),
			},
		};
		expect(getNextSetting(config)).toBeNull();

		// Adding the dependency as its own required unconfigured setting makes
		// IT the next candidate — the flow asks for the dependency first
		// rather than deadlocking on the blocked dependent.
		config.settings.ghost = setting("Ghost");
		expect(getNextSetting(config)?.[0]).toBe("ghost");

		config.settings.ghost.value = "now-set";
		expect(getNextSetting(config)?.[0]).toBe("orphan");
	});

	it("skips a setting when its visibleIf predicate returns true", () => {
		const config: SetupConfig = {
			settings: {
				hidden: setting("Hidden", { visibleIf: () => true }),
				shown: setting("Shown"),
			},
		};
		// visibleIf returning true marks the setting not-visible to the flow:
		// the next candidate must be the plain one, never the gated one.
		expect(getNextSetting(config)?.[0]).toBe("shown");

		config.settings.shown.value = "x";
		expect(getNextSetting(config)).toBeNull();
		// Visibility does not feed completion: the hidden-but-null setting
		// still keeps setup incomplete.
		expect(isSetupComplete(config)).toBe(false);
	});

	it("falls back to eligible unconfigured optionals after required work", () => {
		const config: SetupConfig = {
			settings: {
				reqDone: setting("Req Done", { value: "y" }),
				optBlocked: setting("Opt Blocked", {
					required: false,
					dependsOn: ["missingDep"],
				}),
				optReady: setting("Opt Ready", { required: false }),
			},
		};
		expect(getNextSetting(config)?.[0]).toBe("optReady");
	});

	it("returns null once every required and optional setting is configured", () => {
		const config: SetupConfig = {
			settings: {
				done: setting("Done", { value: "v" }),
				extra: setting("Extra", { required: false, value: "w" }),
			},
		};
		expect(getNextSetting(config)).toBeNull();
		expect(isSetupComplete(config)).toBe(true);
	});
});

describe("generateSettingPrompt", () => {
	const base: SetupSetting = {
		name: "OpenAI API Key",
		description: "Key used for OpenAI calls",
		secret: true,
		public: false,
		required: true,
		dependsOn: [],
	};

	it("names the agent, the setting, and the required marker", () => {
		const prompt = generateSettingPrompt("OPENAI_API_KEY", base, "Atlas");
		expect(prompt).toContain("Atlas needs to collect the OpenAI API Key");
		expect(prompt).toContain("(Required)");
		// Without usageDescription the description carries the prompt.
		expect(prompt).toContain("Description: Key used for OpenAI calls");
	});

	it("prefers usageDescription over description and flips the marker for optionals", () => {
		const prompt = generateSettingPrompt(
			"KEY",
			{ ...base, required: false, usageDescription: "Starts with sk-" },
			"Atlas",
		);
		expect(prompt).toContain("(Optional)");
		expect(prompt).toContain("Description: Starts with sk-");
		expect(prompt).not.toContain("Key used for OpenAI calls");
	});
});

describe("default messages contract", () => {
	it("keeps the {{settingName}} placeholder the substitution flow relies on", () => {
		expect(DEFAULT_SETUP_MESSAGES.welcome.length).toBeGreaterThan(0);
		expect(DEFAULT_SETUP_MESSAGES.askSetting).toContain("{{settingName}}");
		expect(DEFAULT_SETUP_MESSAGES.settingUpdated).toContain("{{settingName}}");
	});
});
