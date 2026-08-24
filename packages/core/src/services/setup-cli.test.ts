/**
 * Exercises CLISetupAdapter and the runNonInteractiveSetup helper against the
 * real SetupStateMachine: per-step CLI prompt generation, CLI input parsing
 * branches, progress-bar rendering, navigation (goBack/reset/skip), and
 * end-to-end non-interactive flows. Deterministic harness — no network,
 * database, or model involvement.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives.ts";
import {
	SETUP_STEP_LABELS,
	SETUP_STEP_ORDER,
	SetupStep,
} from "../types/setup.ts";
import {
	AUTH_METHODS,
	CHANNELS,
	CLISetupAdapter,
	createCLISetupAdapter,
	MODEL_PROVIDERS,
	RISK_ACKNOWLEDGEMENT_TEXT,
	runNonInteractiveSetup,
} from "./setup-cli.ts";
import { SetupStateMachine } from "./setup-state.ts";

const API_KEY = "sk-1234567890abcdef";
const USER_ID = "00000000-0000-0000-0000-0000000000u1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000w1" as UUID;

async function advancePastRiskAck(): Promise<CLISetupAdapter> {
	const adapter = new CLISetupAdapter();
	await adapter.advanceStep({
		step: SetupStep.WELCOME,
		data: { acknowledged: true },
	});
	await adapter.advanceStep({
		step: SetupStep.RISK_ACK,
		data: { accepted: true },
	});
	return adapter;
}

describe("setup-cli constants", () => {
	it("exports seven unique model providers led by Anthropic", () => {
		expect(MODEL_PROVIDERS.map((p) => p.value)).toEqual([
			"anthropic",
			"openai",
			"google",
			"groq",
			"xai",
			"openrouter",
			"ollama",
		]);
		expect(MODEL_PROVIDERS[0]).toMatchObject({
			value: "anthropic",
			label: "Anthropic (Claude)",
			hint: "Recommended",
		});
	});

	it("exports five unique channels including the built-in web interface", () => {
		expect(CHANNELS.map((c) => c.value)).toEqual([
			"discord",
			"telegram",
			"twitter",
			"slack",
			"web",
		]);
		expect(new Set(CHANNELS.map((c) => c.value)).size).toBe(CHANNELS.length);
	});

	it("exports three auth methods", () => {
		expect(AUTH_METHODS.map((m) => m.value)).toEqual([
			"api_key",
			"oauth",
			"setup_token",
		]);
	});

	it("exports risk acknowledgement text covering the key security sections", () => {
		expect(RISK_ACKNOWLEDGEMENT_TEXT).toContain(
			"IMPORTANT SECURITY INFORMATION",
		);
		expect(RISK_ACKNOWLEDGEMENT_TEXT).toContain("API KEY SECURITY");
		expect(RISK_ACKNOWLEDGEMENT_TEXT).toContain("EXECUTION CAPABILITIES");
		expect(RISK_ACKNOWLEDGEMENT_TEXT).toContain("NETWORK ACCESS");
	});
});

describe("CLISetupAdapter construction", () => {
	it("defaults to the WELCOME step on the cli platform in cli mode", () => {
		const adapter = new CLISetupAdapter();
		expect(adapter.getCurrentStep()).toBe(SetupStep.WELCOME);
		const context = adapter.getContext();
		expect(context.platform).toBe("cli");
		expect(context.mode).toBe("cli");
		expect(context.completedSteps).toEqual([]);
		expect(context.sessionId).toBeTruthy();
	});

	it("exposes the underlying SetupStateMachine", () => {
		const adapter = new CLISetupAdapter();
		expect(adapter.getStateMachine()).toBeInstanceOf(SetupStateMachine);
	});

	it("forwards identity config into the setup context", () => {
		const adapter = createCLISetupAdapter({
			userId: USER_ID,
			worldId: WORLD_ID,
		});
		const context = adapter.getContext();
		expect(context.userId).toBe(USER_ID);
		expect(context.worldId).toBe(WORLD_ID);
		expect(context.platform).toBe("cli");
	});

	it("restores an existing context instead of starting over", async () => {
		const source = await advancePastRiskAck();
		const restored = new CLISetupAdapter({
			existingContext: source.getContext(),
		});
		expect(restored.getCurrentStep()).toBe(SetupStep.AUTH);
		expect(restored.getContext().completedSteps).toContain(SetupStep.RISK_ACK);
	});
});

describe("CLISetupAdapter.promptForStep", () => {
	it("renders a single opt-in confirm prompt for WELCOME by default", () => {
		const prompts = new CLISetupAdapter().promptForStep();
		expect(prompts).toHaveLength(1);
		expect(prompts[0].type).toBe("confirm");
		expect(prompts[0].defaultValue).toBe(true);
		expect(prompts[0].title).toBe("Welcome to Otto Setup");
		expect(prompts[0].description).toContain(
			"Introduction to the setup process",
		);
	});

	it("renders the mandatory risk acknowledgement for RISK_ACK", () => {
		const prompts = new CLISetupAdapter().promptForStep(SetupStep.RISK_ACK);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].title).toBe(SETUP_STEP_LABELS[SetupStep.RISK_ACK]);
		expect(prompts[0].description).toBe(RISK_ACKNOWLEDGEMENT_TEXT);
		expect(prompts[0].defaultValue).toBe(false);
		expect(prompts[0].required).toBe(true);
	});

	it("renders provider, method, and API-key prompts for AUTH", () => {
		const prompts = new CLISetupAdapter().promptForStep(SetupStep.AUTH);
		expect(prompts).toHaveLength(3);

		expect(prompts[0].title).toBe("Select Model Provider");
		expect(prompts[0].options?.map((o) => o.value)).toEqual(
			MODEL_PROVIDERS.map((p) => p.value),
		);
		expect(prompts[0].defaultValue).toBe("anthropic");

		expect(prompts[1].title).toBe("Authentication Method");
		expect(prompts[1].options?.map((o) => o.value)).toEqual(
			AUTH_METHODS.map((m) => m.value),
		);
		expect(prompts[1].defaultValue).toBe("api_key");

		expect(prompts[2].type).toBe("password");
		expect(prompts[2].placeholder).toBe("sk-...");
		expect(prompts[2].required).toBe(true);
	});

	it("rejects short or blank API keys through the AUTH prompt validator", () => {
		const prompts = new CLISetupAdapter().promptForStep(SetupStep.AUTH);
		const validate = prompts[2].validate;
		expect(validate).toBeDefined();
		expect(validate?.("")).toBe("API key appears too short");
		expect(validate?.("short")).toBe("API key appears too short");
		expect(validate?.("          ")).toBe("API key appears too short");
		expect(validate?.(API_KEY)).toBeUndefined();
	});

	it("renders a multiselect of all channels for CHANNELS", () => {
		const prompts = new CLISetupAdapter().promptForStep(SetupStep.CHANNELS);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].type).toBe("multiselect");
		expect(prompts[0].options?.map((o) => o.value)).toEqual(
			CHANNELS.map((c) => c.value),
		);
		expect(prompts[0].defaultValue).toEqual([]);
	});

	it("renders package-manager and Homebrew prompts for SKILLS", () => {
		const prompts = new CLISetupAdapter().promptForStep(SetupStep.SKILLS);
		expect(prompts).toHaveLength(2);
		expect(prompts[0].type).toBe("select");
		expect(prompts[0].options?.map((o) => o.value)).toEqual(["bun", "npm"]);
		expect(prompts[0].defaultValue).toBe("bun");
		expect(prompts[1].type).toBe("confirm");
		expect(prompts[1].defaultValue).toBe(true);
	});

	it("summarises collected settings in the COMPLETE prompt", async () => {
		const adapter = new CLISetupAdapter();
		await runNonInteractiveSetup(adapter, {
			provider: "openai",
			apiKey: API_KEY,
			channels: ["discord", "slack"],
			skills: ["shell", "browser"],
			nodeManager: "bun",
		});

		const prompts = adapter.promptForStep(SetupStep.COMPLETE);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].type).toBe("confirm");
		expect(prompts[0].description).toContain("Provider: openai");
		expect(prompts[0].description).toContain(`****${API_KEY.slice(-4)}`);
		expect(prompts[0].description).toContain("Enabled: discord, slack");
		expect(prompts[0].description).toContain("Enabled: shell, browser");
		expect(prompts[0].description).toContain("Package Manager: bun");
		expect(prompts[0].description).toContain("Run 'otto start' to begin.");
		expect(prompts[0].description).not.toContain(API_KEY);
	});

	it("returns no prompts and empty help for an unrecognised step", () => {
		const adapter = new CLISetupAdapter();
		const bogusStep = "BOGUS" as string;
		expect(adapter.promptForStep(bogusStep as SetupStep)).toEqual([]);
		expect(adapter.getStepHelp(bogusStep as SetupStep)).toBe("");
	});
});

describe("CLISetupAdapter.parseCliInput", () => {
	it("defaults WELCOME to acknowledged and keeps an optional user name", () => {
		const parsed = new CLISetupAdapter().parseCliInput({});
		expect(parsed.success).toBe(true);
		expect(parsed.input?.step).toBe(SetupStep.WELCOME);
		expect(parsed.input?.data).toMatchObject({ acknowledged: true });
		expect(parsed.error).toBeUndefined();

		const named = new CLISetupAdapter().parseCliInput({ userName: "Ada" });
		expect(named.success).toBe(true);
		expect(named.input?.data).toMatchObject({
			acknowledged: true,
			userName: "Ada",
		});
	});

	it("parses a WELCOME decline as successful input for the state machine to reject", () => {
		const parsed = new CLISetupAdapter().parseCliInput({
			acknowledged: false,
		});
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toMatchObject({ acknowledged: false });
	});

	it("requires acceptance for RISK_ACK and carries the warning text forward", () => {
		const declined = new CLISetupAdapter().parseCliInput(
			{},
			SetupStep.RISK_ACK,
		);
		expect(declined.success).toBe(false);
		expect(declined.error).toBe("Risk acknowledgement is required to continue");

		const confirmed = new CLISetupAdapter().parseCliInput(
			{ confirm: true },
			SetupStep.RISK_ACK,
		);
		expect(confirmed.success).toBe(true);
		expect(confirmed.input?.step).toBe(SetupStep.RISK_ACK);
		expect(confirmed.input?.data).toMatchObject({ accepted: true });
		expect(confirmed.input?.data.warningText).toBe(RISK_ACKNOWLEDGEMENT_TEXT);
	});

	it("rejects AUTH without an API key and preserves a supplied one", () => {
		const missing = new CLISetupAdapter().parseCliInput({}, SetupStep.AUTH);
		expect(missing.success).toBe(false);
		expect(missing.error).toBe("API key is required");

		const provided = new CLISetupAdapter().parseCliInput(
			{
				apiKey: API_KEY,
				provider: "openai",
			},
			SetupStep.AUTH,
		);
		expect(provided.success).toBe(true);
		expect(provided.input?.step).toBe(SetupStep.AUTH);
		expect(provided.input?.data).toMatchObject({
			method: "api_key",
			provider: "openai",
			apiKey: API_KEY,
		});
	});

	it("supports the authMethod alias and the setup_token method", () => {
		const missingToken = new CLISetupAdapter().parseCliInput(
			{ method: "setup_token" },
			SetupStep.AUTH,
		);
		expect(missingToken.success).toBe(false);
		expect(missingToken.error).toBe("Setup token is required");

		const aliased = new CLISetupAdapter().parseCliInput(
			{
				authMethod: "setup_token",
				setupToken: "tok-123456789",
			},
			SetupStep.AUTH,
		);
		expect(aliased.success).toBe(true);
		expect(aliased.input?.data).toMatchObject({
			method: "setup_token",
			setupToken: "tok-123456789",
		});
	});

	it("requires complete OAuth callback data and forwards it verbatim", () => {
		const incomplete = new CLISetupAdapter().parseCliInput(
			{
				method: "oauth",
				oauthCode: "only-code",
			},
			SetupStep.AUTH,
		);
		expect(incomplete.success).toBe(false);
		expect(incomplete.error).toBe("OAuth callback data is required");

		const complete = new CLISetupAdapter().parseCliInput(
			{
				method: "oauth",
				oauthCode: "code-1",
				oauthState: "state-1",
			},
			SetupStep.AUTH,
		);
		expect(complete.success).toBe(true);
		expect(complete.input?.data).toMatchObject({
			method: "oauth",
			oauthCallback: { code: "code-1", state: "state-1" },
		});
	});

	it("parses an AUTH skip as api_key with the skip flag", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{ skip: true },
			SetupStep.AUTH,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toEqual({
			method: "api_key",
			skip: true,
		});
	});

	it("builds enabled channel entries and attaches matching credentials", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{
				channels: ["discord", "telegram"],
				channelConfigs: { discord: { token: "t0k3n" } },
				dmPolicy: { requireApproval: true },
			},
			SetupStep.CHANNELS,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data.channels).toEqual([
			{
				type: "discord",
				enabled: true,
				credentials: { token: "t0k3n" },
			},
			{
				type: "telegram",
				enabled: true,
				credentials: undefined,
			},
		]);
		expect(parsed.input?.data.dmPolicy).toEqual({ requireApproval: true });
	});

	it("accepts the selected alias and passes an empty selection through", () => {
		const aliased = new CLISetupAdapter().parseCliInput(
			{ selected: ["web"] },
			SetupStep.CHANNELS,
		);
		expect(aliased.success).toBe(true);
		expect(aliased.input?.data.channels).toEqual([
			{ type: "web", enabled: true, credentials: undefined },
		]);

		const empty = new CLISetupAdapter().parseCliInput({}, SetupStep.CHANNELS);
		expect(empty.success).toBe(true);
		expect(empty.input?.data.channels).toEqual([]);
		expect(empty.input?.data.dmPolicy).toBeUndefined();
	});

	it("marks a CHANNELS skip with an empty channel list", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{ skip: true },
			SetupStep.CHANNELS,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toEqual({ channels: [], skip: true });
	});

	it("maps skill aliases and records explicit installation preferences", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{
				enabledSkills: ["shell"],
				skillsToInstall: ["browser"],
				useHomebrew: false,
				nodeManager: "npm",
			},
			SetupStep.SKILLS,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toEqual({
			skills: ["shell"],
			install: ["browser"],
			preferences: { useHomebrew: false, nodeManager: "npm" },
		});
	});

	it("omits unset skill preferences entirely", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{ skills: ["shell"] },
			SetupStep.SKILLS,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toEqual({
			skills: ["shell"],
			install: [],
			preferences: {},
		});
	});

	it("marks a SKILLS skip with empty lists", () => {
		const parsed = new CLISetupAdapter().parseCliInput(
			{ skip: true },
			SetupStep.SKILLS,
		);
		expect(parsed.success).toBe(true);
		expect(parsed.input?.data).toEqual({
			skills: [],
			install: [],
			skip: true,
		});
	});

	it("completes instantly and reports unknown steps as failures", () => {
		const done = new CLISetupAdapter().parseCliInput({}, SetupStep.COMPLETE);
		expect(done).toEqual({
			success: true,
			input: { step: SetupStep.COMPLETE, data: {} },
		});

		const bogusStep = "BOGUS" as string;
		const unknown = new CLISetupAdapter().parseCliInput(
			{},
			bogusStep as SetupStep,
		);
		expect(unknown.success).toBe(false);
		expect(unknown.error).toBe("Unknown step: BOGUS");
	});
});

describe("CLISetupAdapter navigation and advancement", () => {
	it("advances WELCOME to RISK_ACK and records the completed step", async () => {
		const adapter = new CLISetupAdapter();
		const result = await adapter.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(result.success).toBe(true);
		expect(result.newStep).toBe(SetupStep.RISK_ACK);
		expect(result.isComplete).toBe(false);
		expect(adapter.getCurrentStep()).toBe(SetupStep.RISK_ACK);
		expect(adapter.getContext().completedSteps).toEqual([SetupStep.WELCOME]);
	});

	it("reports STEP_MISMATCH when input does not match the current step", async () => {
		const adapter = new CLISetupAdapter();
		const result = await adapter.advanceStep({
			step: SetupStep.SKILLS,
			data: { skills: [], install: [], skip: true },
		});
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("STEP_MISMATCH");
		expect(result.newStep).toBe(SetupStep.WELCOME);
		expect(adapter.getContext().errors).toHaveLength(1);
		expect(adapter.getCurrentStep()).toBe(SetupStep.WELCOME);
	});

	it("goes back one step and keeps only earlier completed steps", async () => {
		const adapter = await advancePastRiskAck();
		expect(adapter.getCurrentStep()).toBe(SetupStep.AUTH);
		const result = adapter.goBack();
		expect(result.success).toBe(true);
		expect(result.newStep).toBe(SetupStep.RISK_ACK);
		expect(adapter.getContext().completedSteps).toEqual([SetupStep.WELCOME]);
	});

	it("refuses to go back past the first step or forward to an invalid target", async () => {
		const fresh = new CLISetupAdapter();
		const noPrevious = fresh.goBack();
		expect(noPrevious.success).toBe(false);
		expect(noPrevious.error?.code).toBe("NO_PREVIOUS_STEP");

		const adapter = await advancePastRiskAck();
		const invalidTarget = adapter.goBack(SetupStep.AUTH);
		expect(invalidTarget.success).toBe(false);
		expect(invalidTarget.error?.code).toBe("INVALID_TARGET");
		expect(adapter.getCurrentStep()).toBe(SetupStep.AUTH);
	});

	it("resets to a pristine WELCOME context", async () => {
		const adapter = await advancePastRiskAck();
		adapter.reset();
		expect(adapter.getCurrentStep()).toBe(SetupStep.WELCOME);
		const context = adapter.getContext();
		expect(context.completedSteps).toEqual([]);
		expect(context.errors).toEqual([]);
		expect(context.settings).toEqual({});
	});

	it("cannot skip the unskippable WELCOME step", async () => {
		const result = await new CLISetupAdapter().skipStep();
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("CANNOT_SKIP");
	});

	it("skips AUTH, CHANNELS, and SKILLS through to completion without settings", async () => {
		const adapter = await advancePastRiskAck();

		const authSkip = await adapter.skipStep();
		expect(authSkip.success).toBe(true);
		expect(authSkip.newStep).toBe(SetupStep.CHANNELS);
		expect(adapter.getContext().settings.auth).toBeUndefined();

		const channelsSkip = await adapter.skipStep();
		expect(channelsSkip.success).toBe(true);
		expect(channelsSkip.newStep).toBe(SetupStep.SKILLS);
		expect(adapter.getContext().settings.channels).toBeUndefined();

		const skillsSkip = await adapter.skipStep();
		expect(skillsSkip.success).toBe(true);
		expect(skillsSkip.isComplete).toBe(true);
		expect(skillsSkip.newStep).toBe(SetupStep.COMPLETE);
		expect(adapter.getContext().settings.skills).toBeUndefined();
	});
});

describe("CLISetupAdapter.formatProgressBar", () => {
	it("renders an empty bar labelled with the current step at the start", () => {
		expect(new CLISetupAdapter().formatProgressBar()).toBe(
			`[${"░".repeat(30)}] 0% - Welcome`,
		);
		expect(new CLISetupAdapter().formatProgressBar(10)).toBe(
			`[${"░".repeat(10)}] 0% - Welcome`,
		);
	});

	it("fills proportionally once the first step completes", async () => {
		const adapter = new CLISetupAdapter();
		await adapter.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(adapter.formatProgressBar()).toBe(
			`[${"█".repeat(6)}${"░".repeat(24)}] 20% - ${SETUP_STEP_LABELS[SetupStep.RISK_ACK]}`,
		);
	});

	it("renders a completely full bar labelled Complete at 100%", async () => {
		const adapter = new CLISetupAdapter();
		await runNonInteractiveSetup(adapter, {});
		expect(adapter.formatProgressBar(30)).toBe(
			`[${"█".repeat(30)}] 100% - Complete`,
		);
	});
});

describe("CLISetupAdapter.getStepHelp", () => {
	it("returns help for every ordered step and defaults to the current one", () => {
		const adapter = new CLISetupAdapter();
		for (const step of SETUP_STEP_ORDER) {
			expect(typeof adapter.getStepHelp(step)).toBe("string");
			expect(adapter.getStepHelp(step).length).toBeGreaterThan(0);
		}
		expect(adapter.getStepHelp()).toBe(adapter.getStepHelp(SetupStep.WELCOME));
	});

	it("lists every supported model provider in the AUTH help text", () => {
		const help = new CLISetupAdapter().getStepHelp(SetupStep.AUTH);
		for (const provider of MODEL_PROVIDERS) {
			expect(help).toContain(provider.label);
		}
		expect(help).toContain("(Recommended)");
	});

	it("explains that RISK_ACK acceptance is mandatory", () => {
		const help = new CLISetupAdapter().getStepHelp(SetupStep.RISK_ACK);
		expect(help).toContain("You must accept to continue");
	});
});

describe("runNonInteractiveSetup", () => {
	it("drives a fully answered flow to completion and stores every setting", async () => {
		const adapter = new CLISetupAdapter();
		const result = await runNonInteractiveSetup(adapter, {
			provider: "openai",
			apiKey: API_KEY,
			channels: ["discord", "slack"],
			skills: ["shell", "browser"],
			nodeManager: "bun",
		});

		expect(result.success).toBe(true);
		expect(result.isComplete).toBe(true);
		expect(result.newStep).toBe(SetupStep.COMPLETE);
		expect(adapter.getCurrentStep()).toBe(SetupStep.COMPLETE);

		const settings = adapter.getContext().settings;
		expect(settings.riskAcknowledged).toBe(true);
		expect(settings.auth).toMatchObject({
			authMethod: "api_key",
			modelProvider: "openai",
			apiKey: API_KEY,
		});
		expect(settings.channels?.enabledChannels).toEqual(["discord", "slack"]);
		expect(settings.skills?.enabledSkills).toEqual(["shell", "browser"]);
		expect(settings.skills?.nodeManager).toBe("bun");
	});

	it("completes an empty answer set with everything skipped", async () => {
		const adapter = new CLISetupAdapter();
		const result = await runNonInteractiveSetup(adapter, {});

		expect(result.success).toBe(true);
		expect(result.isComplete).toBe(true);
		const settings = adapter.getContext().settings;
		expect(settings.auth).toBeUndefined();
		expect(settings.channels).toBeUndefined();
		expect(settings.skills).toBeUndefined();
	});

	it("stops at AUTH when the supplied API key is too short", async () => {
		const adapter = new CLISetupAdapter();
		const result = await runNonInteractiveSetup(adapter, {
			provider: "openai",
			apiKey: "short",
		});

		expect(result.success).toBe(false);
		expect(result.isComplete).toBe(false);
		expect(result.error?.code).toBe("AUTH_VALIDATION_FAILED");
		expect(result.newStep).toBe(SetupStep.AUTH);
		expect(adapter.getCurrentStep()).toBe(SetupStep.AUTH);
	});
});
