/**
 * Onboarding Progress Provider
 *
 * Injects onboarding state into LLM context. Shows current step,
 * what's configured, and what's missing.
 */

import { logger } from "../logger";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types";
import {
	calculateProgress,
	ONBOARDING_STEP_DESCRIPTIONS,
	ONBOARDING_STEP_LABELS,
	type OnboardingContext,
	OnboardingStep,
	type SerializedOnboardingState,
} from "../types/onboarding";
import { ChannelType } from "../types/primitives";

const MAX_ONBOARDING_OUTPUT_LENGTH = 5000;
const MAX_ONBOARDING_ERRORS = 8;
const MAX_ONBOARDING_CHANNELS = 10;
const MAX_ONBOARDING_SKILLS = 12;
const MAX_ONBOARDING_MISSING_ITEMS = 8;

/**
 * Format a step status for display.
 */
function formatStepStatus(
	status: "completed" | "current" | "pending" | "error",
): string {
	switch (status) {
		case "completed":
			return "✓";
		case "current":
			return "→";
		case "pending":
			return "○";
		case "error":
			return "✗";
	}
}

/**
 * Generate onboarding progress text for LLM context.
 */
function generateProgressText(
	context: OnboardingContext,
	agentName: string,
): string {
	const progress = calculateProgress(context);
	const currentStep = context.currentStep;
	const isComplete = currentStep === OnboardingStep.COMPLETE;

	if (isComplete) {
		return `## Onboarding Status: Complete

${agentName} has been fully configured and is ready to operate.

Completed setup:
${context.completedSteps.map((step) => `- ${ONBOARDING_STEP_LABELS[step]}`).join("\n")}`;
	}

	let output = `## Onboarding Status: ${progress}% Complete

**Current Step:** ${ONBOARDING_STEP_LABELS[currentStep]}
**Description:** ${ONBOARDING_STEP_DESCRIPTIONS[currentStep]}

### Progress:
`;

	// List all steps with their status
	for (const step of Object.values(OnboardingStep)) {
		if (step === OnboardingStep.COMPLETE) continue;

		let status: string;
		if (context.completedSteps.includes(step)) {
			status = formatStepStatus("completed");
		} else if (step === currentStep) {
			status = formatStepStatus("current");
		} else {
			status = formatStepStatus("pending");
		}

		output += `${status} ${ONBOARDING_STEP_LABELS[step]}\n`;
	}

	// Add configured settings summary
	output += "\n### Configuration Summary:\n";

	if (context.settings.riskAcknowledged) {
		output += "- Risk acknowledgement: Accepted\n";
	}

	if (context.settings.auth) {
		const auth = context.settings.auth;
		output += `- Authentication: ${auth.modelProvider || "Not set"} (${auth.authMethod || "not configured"})\n`;
	} else {
		output += "- Authentication: Not configured\n";
	}

	if (context.settings.channels) {
		const channels = context.settings.channels;
		if (channels.enabledChannels.length > 0) {
			output += `- Channels: ${channels.enabledChannels.slice(0, MAX_ONBOARDING_CHANNELS).join(", ")}\n`;
		} else {
			output += "- Channels: None configured\n";
		}
	} else {
		output += "- Channels: Not configured\n";
	}

	if (context.settings.skills) {
		const skills = context.settings.skills;
		if (skills.enabledSkills.length > 0) {
			output += `- Skills: ${skills.enabledSkills.slice(0, MAX_ONBOARDING_SKILLS).join(", ")}\n`;
		} else {
			output += "- Skills: None configured\n";
		}
	} else {
		output += "- Skills: Not configured\n";
	}

	// Add errors if any
	if (context.errors.length > 0) {
		output += "\n### Errors:\n";
		for (const error of context.errors.slice(0, MAX_ONBOARDING_ERRORS)) {
			output += `- [${ONBOARDING_STEP_LABELS[error.step]}] ${error.message}\n`;
		}
	}

	// Add instructions based on current step
	output += `\n### Instructions for ${agentName}:\n`;

	switch (currentStep) {
		case OnboardingStep.WELCOME:
			output += "- Greet the user and ask if they're ready to begin setup\n";
			output += "- Explain what the onboarding process will cover\n";
			break;

		case OnboardingStep.RISK_ACK:
			output += "- Present the security and risk information to the user\n";
			output += "- User MUST explicitly acknowledge to proceed\n";
			output += "- Do not proceed without explicit acceptance\n";
			break;

		case OnboardingStep.AUTH:
			output +=
				"- Help the user configure authentication with an AI provider\n";
			output +=
				"- Supported providers: Anthropic, OpenAI, Google, Groq, etc.\n";
			output +=
				"- Ask for their API key or guide them through OAuth if available\n";
			output += "- This step can be skipped if using local models\n";
			break;

		case OnboardingStep.CHANNELS:
			output +=
				"- Help the user configure messaging channels (Discord, Telegram, etc.)\n";
			output += "- Each channel requires appropriate tokens/credentials\n";
			output += "- This step can be skipped and configured later\n";
			break;

		case OnboardingStep.SKILLS:
			output += "- Help the user configure agent skills and capabilities\n";
			output += "- Skills may require dependencies to be installed\n";
			output += "- This step can be skipped and configured later\n";
			break;
	}

	return output;
}

/**
 * Onboarding Progress Provider
 *
 * Provides the current onboarding state to the LLM context.
 * Only active when onboarding is in progress.
 */
export const onboardingProgressProvider: Provider = {
	name: "ONBOARDING_PROGRESS",
	description: "Current onboarding progress and state for the agent",
	contexts: ["settings"],
	contextGate: { anyOf: ["settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		try {
			const room = await runtime.getRoom(message.roomId);
			if (!room?.worldId) {
				return {
					data: { onboarding: null },
					values: { onboardingProgress: "" },
					text: "",
				};
			}

			if (room.type !== ChannelType.DM) {
				return {
					data: { onboarding: null },
					values: { onboardingProgress: "" },
					text: "",
				};
			}

			const world = await runtime.getWorld(room.worldId);
			if (!world?.metadata) {
				return {
					data: { onboarding: null },
					values: { onboardingProgress: "" },
					text: "",
				};
			}

			const metadata = world.metadata as {
				onboardingStateMachine?: SerializedOnboardingState;
			};

			if (!metadata.onboardingStateMachine) {
				return {
					data: { onboarding: null },
					values: { onboardingProgress: "" },
					text: "",
				};
			}

			const context = metadata.onboardingStateMachine.context;
			const agentName = runtime.character.name ?? "Agent";

			let progressText = generateProgressText(context, agentName);
			if (progressText.length > MAX_ONBOARDING_OUTPUT_LENGTH) {
				progressText = `${progressText.slice(0, MAX_ONBOARDING_OUTPUT_LENGTH)}...`;
			}

			logger.debug(
				{
					worldId: room.worldId,
					currentStep: context.currentStep,
					progress: calculateProgress(context),
				},
				"[OnboardingProgressProvider] Providing onboarding context",
			);

			return {
				data: {
					onboarding: {
						context,
						isComplete: context.currentStep === OnboardingStep.COMPLETE,
						progress: calculateProgress(context),
					},
					truncated: progressText.length >= MAX_ONBOARDING_OUTPUT_LENGTH,
				},
				values: {
					onboardingProgress: progressText,
					currentOnboardingStep: context.currentStep,
					onboardingComplete: String(
						context.currentStep === OnboardingStep.COMPLETE,
					),
				},
				text: progressText,
			};
		} catch (error) {
			return {
				data: {
					onboarding: null,
					error: error instanceof Error ? error.message : String(error),
				},
				values: { onboardingProgress: "" },
				text: "",
			};
		}
	},
};

/**
 * Provider that shows what's missing in the onboarding.
 */
export const onboardingMissingProvider: Provider = {
	name: "ONBOARDING_MISSING",
	description: "Lists what still needs to be configured during onboarding",
	contexts: ["settings"],
	contextGate: { anyOf: ["settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		try {
			const room = await runtime.getRoom(message.roomId);
			if (!room?.worldId) {
				return {
					data: { missing: [] },
					values: { onboardingMissing: "" },
					text: "",
				};
			}

			const world = await runtime.getWorld(room.worldId);
			const metadata = world?.metadata as {
				onboardingStateMachine?: SerializedOnboardingState;
			};

			if (!metadata?.onboardingStateMachine) {
				return {
					data: { missing: [] },
					values: { onboardingMissing: "" },
					text: "",
				};
			}

			const context = metadata.onboardingStateMachine.context;
			const missing: string[] = [];

			if (!context.settings.riskAcknowledged) {
				missing.push("Risk acknowledgement");
			}

			if (
				!context.settings.auth?.apiKey &&
				!context.settings.auth?.oauthTokens
			) {
				missing.push("AI provider authentication");
			}

			if (
				!context.settings.channels ||
				context.settings.channels.enabledChannels.length === 0
			) {
				missing.push("Messaging channels");
			}

			if (
				!context.settings.skills ||
				context.settings.skills.enabledSkills.length === 0
			) {
				missing.push("Agent skills");
			}

			if (missing.length === 0) {
				return {
					data: { missing: [] },
					values: {
						onboardingMissing: "All onboarding steps have been completed.",
					},
					text: "All onboarding steps have been completed.",
				};
			}

			const visibleMissing = missing.slice(0, MAX_ONBOARDING_MISSING_ITEMS);
			const text = `Still needs configuration:\n${visibleMissing.map((m) => `- ${m}`).join("\n")}`;

			return {
				data: {
					missing: visibleMissing,
					omittedCount: missing.length - visibleMissing.length,
				},
				values: { onboardingMissing: text },
				text,
			};
		} catch (error) {
			return {
				data: {
					missing: [],
					error: error instanceof Error ? error.message : String(error),
				},
				values: { onboardingMissing: "" },
				text: "",
			};
		}
	},
};
