/**
 * Unit tests for setup state machine transitions, step validations, serialization, and summaries.
 */

import { describe, expect, it, vi } from "vitest";
import { SetupStep } from "../types/setup.js";
import {
	createSetupStateMachine,
	getSetupSummary,
	isSetupComplete,
	SetupStateMachine,
} from "./setup-state.js";

describe("setup-state", () => {
	it("initializes state machine at WELCOME step and transitions through flow", async () => {
		const onStepChange = vi.fn();
		const onComplete = vi.fn();

		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
			onStepChange,
			onComplete,
		});

		expect(sm.getCurrentStep()).toBe(SetupStep.WELCOME);
		expect(sm.canAdvance()).toBe(true);

		// 1. Advance WELCOME
		const res1 = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Alice" },
		});
		expect(res1.success).toBe(true);
		expect(res1.newStep).toBe(SetupStep.RISK_ACK);
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		// 2. Advance RISK_ACK
		const res2 = await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		expect(res2.success).toBe(true);
		expect(res2.newStep).toBe(SetupStep.AUTH);

		// 3. Skip AUTH
		const res3 = await sm.skipStep();
		expect(res3.success).toBe(true);
		expect(res3.newStep).toBe(SetupStep.CHANNELS);

		// 4. Skip CHANNELS
		const res4 = await sm.skipStep();
		expect(res4.success).toBe(true);
		expect(res4.newStep).toBe(SetupStep.SKILLS);

		// 5. Complete SKILLS
		const res5 = await sm.advanceStep({
			step: SetupStep.SKILLS,
			data: { skills: ["test-skill"], install: [] },
		});
		expect(res5.success).toBe(true);
		expect(res5.isComplete).toBe(true);
		expect(sm.getCurrentStep()).toBe(SetupStep.COMPLETE);
		expect(onComplete).toHaveBeenCalled();
	});

	it("handles step mismatch and validation errors gracefully", async () => {
		const onError = vi.fn();
		const sm = createSetupStateMachine({
			platform: "chat",
			onError,
		});

		// Attempting to advance AUTH while at WELCOME
		const res = await sm.advanceStep({
			step: SetupStep.AUTH,
			data: { method: "api_key", apiKey: "key-1234567890" },
		});

		expect(res.success).toBe(false);
		expect(res.error?.code).toBe("STEP_MISMATCH");
		expect(onError).toHaveBeenCalled();
	});

	it("supports goBack and step rewinds", async () => {
		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
		});

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		const backRes = sm.goBack();
		expect(backRes.success).toBe(true);
		expect(backRes.newStep).toBe(SetupStep.WELCOME);
		expect(sm.getCurrentStep()).toBe(SetupStep.WELCOME);
	});

	it("serializes to JSON and restores from JSON", async () => {
		const sm1 = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
		});

		await sm1.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Bob" },
		});

		const serialized = sm1.toJSON();
		const sm2 = SetupStateMachine.fromJSON(serialized, {
			platform: "cli",
			mode: "cli",
		});

		expect(sm2.getCurrentStep()).toBe(SetupStep.RISK_ACK);
		expect(sm2.getContext().metadata?.userName).toBe("Bob");
	});

	it("formats setup summary correctly", () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });
		const summary = getSetupSummary(sm.getContext());
		expect(summary).toContain("Setup Progress:");
		expect(summary).toContain("Current Step:");
		expect(isSetupComplete(sm.getContext())).toBe(false);
	});
});

describe("setup-state additional coverage", () => {
	const reachAuth = async () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });
		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		return sm;
	};

	const reachChannels = async () => {
		const sm = await reachAuth();
		await sm.advanceStep({ step: SetupStep.AUTH, data: { skip: true } });
		return sm;
	};

	const reachSkills = async () => {
		const sm = await reachChannels();
		await sm.advanceStep({
			step: SetupStep.CHANNELS,
			data: { channels: [], skip: true },
		});
		return sm;
	};

	it("blocks canAdvance and reports completion once the flow reaches COMPLETE", async () => {
		const onComplete = vi.fn();
		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
			onComplete,
		});

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		await sm.advanceStep({ step: SetupStep.AUTH, data: { skip: true } });
		await sm.advanceStep({
			step: SetupStep.CHANNELS,
			data: { channels: [], skip: true },
		});
		const final = await sm.skipStep();

		expect(final.isComplete).toBe(true);
		expect(final.message).toBe("Setup complete!");
		expect(sm.getCurrentStep()).toBe(SetupStep.COMPLETE);
		expect(sm.canAdvance()).toBe(false);
		expect(isSetupComplete(sm.getContext())).toBe(true);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("surfaces step statuses, error state, and percentage in getProgress", async () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });

		const fresh = sm.getProgress();
		expect(fresh.totalSteps).toBe(6);
		expect(fresh.currentStepNumber).toBe(1);
		expect(fresh.percentage).toBe(0);
		expect(fresh.steps[0]).toMatchObject({
			step: SetupStep.WELCOME,
			status: "current",
		});
		expect(fresh.steps[5]?.status).toBe("pending");

		const rejected = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: false },
		});
		expect(rejected.success).toBe(false);

		const mismatch = await sm.advanceStep({
			step: SetupStep.SKILLS,
			data: { skills: [] },
		});
		expect(mismatch.success).toBe(false);

		const errored = sm.getProgress();
		expect(errored.steps[0]).toMatchObject({
			step: SetupStep.WELCOME,
			status: "error",
			errorMessage: "Cannot process step SKILLS when current step is WELCOME",
		});

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		const advanced = sm.getProgress();
		expect(advanced.percentage).toBe(20);
		expect(advanced.currentStepNumber).toBe(2);
		expect(advanced.steps[0]).toMatchObject({ status: "completed" });
		expect(advanced.steps[1]).toMatchObject({
			step: SetupStep.RISK_ACK,
			status: "current",
		});
	});

	it("returns NOT_ACKNOWLEDGED failures in the result without leaving WELCOME", async () => {
		const onError = vi.fn();
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli", onError });

		const res = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: false },
		});

		expect(res.success).toBe(false);
		expect(res.error?.code).toBe("NOT_ACKNOWLEDGED");
		expect(res.newStep).toBe(SetupStep.WELCOME);
		expect(res.isComplete).toBe(false);
		expect(sm.getCurrentStep()).toBe(SetupStep.WELCOME);
		expect(sm.getContext().errors).toHaveLength(0);
		expect(sm.canAdvance()).toBe(true);
		expect(onError).not.toHaveBeenCalled();
	});

	it("refuses risk rejection with RISK_NOT_ACCEPTED and stores acceptance settings on accept", async () => {
		const sm = await reachAuth();
		expect(sm.getCurrentStep()).toBe(SetupStep.AUTH);

		const rewound = sm.goBack(SetupStep.RISK_ACK);
		expect(rewound.success).toBe(true);

		const refused = await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: false },
		});
		expect(refused.success).toBe(false);
		expect(refused.error?.code).toBe("RISK_NOT_ACCEPTED");
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		const accepted = await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		expect(accepted.success).toBe(true);
		const settings = sm.getSettings();
		expect(settings.riskAcknowledged).toBe(true);
		expect(typeof settings.riskAcknowledgedAt).toBe("number");
	});

	it("clears recorded errors for a step when it is retried successfully", async () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: false },
		});
		await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		expect(sm.getContext().errors).toHaveLength(1);
		expect(sm.getContext().errors[0]?.code).toBe("STEP_MISMATCH");

		const ok = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(ok.success).toBe(true);
		expect(ok.context.errors).toHaveLength(0);
		expect(sm.getContext().metadata).toBeUndefined();
	});

	it("converts throwing handlers into HANDLER_ERROR results without throwing", async () => {
		const onError = vi.fn();
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli", onError });

		sm.registerHandler(SetupStep.WELCOME, async () => {
			throw new Error("boom");
		});
		const res = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(res.success).toBe(false);
		expect(res.error?.code).toBe("HANDLER_ERROR");
		expect(res.error?.message).toBe("boom");
		expect(res.newStep).toBe(SetupStep.WELCOME);
		expect(sm.getContext().errors[0]?.code).toBe("HANDLER_ERROR");
		expect(onError).toHaveBeenCalledTimes(1);

		sm.registerHandler(SetupStep.WELCOME, async () => {
			throw "string-failure";
		});
		const nonError = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(nonError.success).toBe(false);
		expect(nonError.error?.message).toBe("string-failure");
		expect(nonError.error?.details).toBeUndefined();
	});

	it("validates auth input variants and persists credentials for valid ones", async () => {
		const missingMethod = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: {} as unknown as { method: "api_key" },
		});
		expect(missingMethod.error?.message).toBe(
			"Authentication method is required",
		);

		const missingKey = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: { method: "api_key" },
		});
		expect(missingKey.success).toBe(false);
		expect(missingKey.error?.message).toBe("API key is required");

		const shortKey = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: { method: "api_key", apiKey: "  short  " },
		});
		expect(shortKey.error?.message).toBe("API key appears too short");

		const missingToken = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: { method: "setup_token" },
		});
		expect(missingToken.error?.message).toBe("Setup token is required");

		const partialOauth = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: { method: "oauth", oauthCallback: { code: "c", state: "" } },
		});
		expect(partialOauth.error?.message).toBe("OAuth callback data is partial");

		const unknownMethod = await (await reachAuth()).advanceStep({
			step: SetupStep.AUTH,
			data: { method: "carrier_pigeon" } as unknown as { method: "api_key" },
		});
		expect(unknownMethod.error?.message).toBe(
			"Unknown auth method: carrier_pigeon",
		);

		const apiKeyMachine = await reachAuth();
		const stored = await apiKeyMachine.advanceStep({
			step: SetupStep.AUTH,
			data: {
				method: "api_key",
				provider: "anthropic",
				apiKey: "sk-test-123456",
			},
		});
		expect(stored.success).toBe(true);
		expect(stored.newStep).toBe(SetupStep.CHANNELS);
		expect(apiKeyMachine.getSettings().auth).toEqual({
			authMethod: "api_key",
			modelProvider: "anthropic",
			apiKey: "sk-test-123456",
		});

		const tokenMachine = await reachAuth();
		await tokenMachine.advanceStep({
			step: SetupStep.AUTH,
			data: { method: "setup_token", setupToken: "tok-abcdef" },
		});
		expect(tokenMachine.getSettings().auth?.setupToken).toBe("tok-abcdef");

		const oauthMachine = await reachAuth();
		await oauthMachine.advanceStep({
			step: SetupStep.AUTH,
			data: { method: "oauth", oauthCallback: { code: "c", state: "s" } },
		});
		expect(oauthMachine.getSettings().auth?.oauthTokens?.accessToken).toBe("");
	});

	it("records only enabled channels plus their configs and stores the DM policy", async () => {
		const sm = await reachChannels();
		const res = await sm.advanceStep({
			step: SetupStep.CHANNELS,
			data: {
				channels: [
					{ type: "discord", enabled: true, credentials: { token: "d" } },
					{ type: "telegram", enabled: false },
				],
				dmPolicy: { requireApproval: true },
			},
		});

		expect(res.success).toBe(true);
		expect(res.message).toBe(
			"1 channel(s) configured. Now let's set up skills.",
		);
		const channels = sm.getSettings().channels;
		expect(channels?.enabledChannels).toEqual(["discord"]);
		const discordConfig = channels?.channelConfigs.discord;
		expect(discordConfig?.type).toBe("discord");
		expect(discordConfig?.enabled).toBe(true);
		expect(discordConfig?.credentials).toEqual({ token: "d" });
		expect(channels?.channelConfigs.telegram).toBeUndefined();
		expect(channels?.dmPolicy).toEqual({ requireApproval: true });

		const emptyMachine = await reachChannels();
		const emptyRes = await emptyMachine.advanceStep({
			step: SetupStep.CHANNELS,
			data: { channels: [] },
		});
		expect(emptyRes.success).toBe(true);
		expect(emptyRes.message).toBe(
			"No channels configured. You can add them later.",
		);
		expect(emptyMachine.getSettings().channels?.enabledChannels).toEqual([]);
	});

	it("stores skills preferences; completing steps report the fixed completion message", async () => {
		const sm = await reachSkills();
		const res = await sm.advanceStep({
			step: SetupStep.SKILLS,
			data: {
				skills: ["browser"],
				install: ["scheduling", "health"],
				preferences: { useHomebrew: true, nodeManager: "bun" },
			},
		});

		expect(res.isComplete).toBe(true);
		expect(res.message).toBe("Setup complete!");
		const skills = sm.getSettings().skills;
		expect(skills?.enabledSkills).toEqual(["browser"]);
		expect(skills?.skillsToInstall).toEqual(["scheduling", "health"]);
		expect(skills?.useHomebrew).toBe(true);
		expect(skills?.nodeManager).toBe("bun");

		const bare = await reachSkills();
		const bareRes = await bare.advanceStep({
			step: SetupStep.SKILLS,
			data: { skills: [], install: [] },
		});
		expect(bareRes.isComplete).toBe(true);
		expect(bareRes.message).toBe("Setup complete!");
	});

	it("refuses skipping unskippable steps with CANNOT_SKIP including COMPLETE", async () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });
		const atWelcome = await sm.skipStep();
		expect(atWelcome.success).toBe(false);
		expect(atWelcome.error?.code).toBe("CANNOT_SKIP");

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		const atRiskAck = await sm.skipStep();
		expect(atRiskAck.success).toBe(false);
		expect(atRiskAck.error?.code).toBe("CANNOT_SKIP");
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		await sm.skipStep();
		await sm.skipStep();
		const completed = await sm.skipStep();
		expect(completed.isComplete).toBe(true);
		const atComplete = await sm.skipStep();
		expect(atComplete.success).toBe(false);
		expect(atComplete.error?.code).toBe("CANNOT_SKIP");
		expect(atComplete.newStep).toBe(SetupStep.COMPLETE);
	});

	it("enforces goBack targets and prunes completed steps and errors on rewind", async () => {
		const onStepChange = vi.fn();
		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
			onStepChange,
		});

		const atStart = sm.goBack();
		expect(atStart.success).toBe(false);
		expect(atStart.error?.code).toBe("NO_PREVIOUS_STEP");

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		await sm.advanceStep({
			step: SetupStep.AUTH,
			data: { method: "api_key", apiKey: "sk-test-123456" },
		});
		await sm.advanceStep({ step: SetupStep.SKILLS, data: { skills: [] } });
		expect(sm.getCurrentStep()).toBe(SetupStep.CHANNELS);
		expect(sm.getContext().errors).toHaveLength(1);

		const forward = sm.goBack(SetupStep.SKILLS);
		expect(forward.success).toBe(false);
		expect(forward.error?.code).toBe("INVALID_TARGET");

		const bogus = sm.goBack("BOGUS" as SetupStep);
		expect(bogus.success).toBe(false);
		expect(bogus.error?.code).toBe("INVALID_TARGET");

		const back = sm.goBack(SetupStep.RISK_ACK);
		expect(back.success).toBe(true);
		expect(back.message).toBe("Returned to Risk Acknowledgement");
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);
		expect(sm.getContext().completedSteps).toEqual([SetupStep.WELCOME]);
		expect(sm.getContext().errors).toEqual([]);
		expect(onStepChange).toHaveBeenLastCalledWith(
			SetupStep.CHANNELS,
			SetupStep.RISK_ACK,
			expect.anything(),
		);
	});

	it("restores from serialized state even when the version differs", async () => {
		const sm = new SetupStateMachine({
			platform: "discord",
			mode: "conversational",
		});
		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});

		const serialized = sm.toJSON();
		expect(serialized.version).toBe(1);

		const restored = SetupStateMachine.fromJSON(
			{ version: 999, context: serialized.context },
			{ platform: "discord", mode: "conversational" },
		);
		expect(restored.getCurrentStep()).toBe(SetupStep.RISK_ACK);
		expect(restored.getContext().completedSteps).toEqual([SetupStep.WELCOME]);
		expect(restored.getContext().platform).toBe("discord");
		expect(restored.getContext().mode).toBe("conversational");
	});

	it("reset restores a pristine WELCOME context", async () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });
		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Cara" },
		});
		const beforeSession = sm.getContext().sessionId;

		sm.reset();
		const ctx = sm.getContext();

		expect(ctx.currentStep).toBe(SetupStep.WELCOME);
		expect(ctx.completedSteps).toEqual([]);
		expect(ctx.settings).toEqual({});
		expect(ctx.metadata).toBeUndefined();
		expect(ctx.sessionId).not.toBe(beforeSession);
	});

	it("returns isolated snapshots for scalar context and settings objects", async () => {
		const sm = await reachAuth();

		const ctx = sm.getContext();
		ctx.currentStep = SetupStep.COMPLETE;
		expect(sm.getCurrentStep()).toBe(SetupStep.AUTH);

		const settings = sm.getSettings();
		settings.auth = { authMethod: "api_key", apiKey: "leak" };
		expect(sm.getSettings().auth).toBeUndefined();
		expect(sm.getContext().settings.riskAcknowledged).toBe(true);
	});

	it("defaults conversational mode and renders completed/error sections in summaries", async () => {
		const conversational = createSetupStateMachine({ platform: "chat" });
		expect(conversational.getContext().mode).toBe("conversational");

		const errored = new SetupStateMachine({
			platform: "chat",
			mode: "conversational",
		});
		await errored.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		const errorSummary = getSetupSummary(errored.getContext());
		expect(errorSummary).toContain("**Errors:**");
		expect(errorSummary).toContain(
			"- [WELCOME] Cannot process step RISK_ACK when current step is WELCOME",
		);

		const progressing = new SetupStateMachine({
			platform: "chat",
			mode: "conversational",
		});
		await progressing.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Dana" },
		});
		const progressSummary = getSetupSummary(progressing.getContext());
		expect(progressSummary).toContain("## Setup Progress: 20%");
		expect(progressSummary).toContain("**Completed Steps:**");
		expect(progressSummary).toContain("- Welcome");
		expect(progressSummary).toContain("**Current Step:** Risk Acknowledgement");
	});
});
