/**
 * CLI Onboarding Adapter
 *
 * Wraps the OnboardingStateMachine with CLI-specific logic for terminal prompts.
 * Provides formatted prompts, input parsing, and step-specific CLI flows.
 */

import {
	type AuthInput,
	type ChannelsInput,
	ONBOARDING_STEP_DESCRIPTIONS,
	ONBOARDING_STEP_LABELS,
	type OnboardingContext,
	type OnboardingInput,
	type OnboardingProgress,
	type OnboardingResult,
	OnboardingStep,
	type SkillsInput,
} from "../types/onboarding";
import {
	OnboardingStateMachine,
	type OnboardingStateMachineConfig,
} from "./onboarding-state";

/**
 * Prompt configuration for CLI display.
 */
export interface CliPromptConfig {
	/** Title for the prompt */
	title: string;
	/** Description or instruction text */
	description: string;
	/** Type of prompt (confirm, text, select, multiselect, password) */
	type: "confirm" | "text" | "select" | "multiselect" | "password";
	/** Options for select/multiselect prompts */
	options?: Array<{
		value: string;
		label: string;
		hint?: string;
	}>;
	/** Default value */
	defaultValue?: string | boolean | string[];
	/** Placeholder text for input */
	placeholder?: string;
	/** Validation function */
	validate?: (value: string) => string | undefined;
	/** Whether the input is required */
	required?: boolean;
}

/**
 * Result of parsing CLI input.
 */
export interface ParsedCliInput {
	/** Whether parsing was successful */
	success: boolean;
	/** The parsed input ready for the state machine */
	input?: OnboardingInput;
	/** Error message if parsing failed */
	error?: string;
}

/**
 * Risk acknowledgement text for display.
 */
export const RISK_ACKNOWLEDGEMENT_TEXT = `
════════════════════════════════════════════════════════════════════════════════
                          IMPORTANT SECURITY INFORMATION
════════════════════════════════════════════════════════════════════════════════

By proceeding with this setup, you acknowledge and accept the following:

1. API KEY SECURITY
   Your API keys provide access to paid services. Keep them secure and never
   share them publicly. Leaked keys can result in unauthorized charges.

2. EXECUTION CAPABILITIES
   This agent can execute commands and code on your system. Always review
   actions before approving them, especially commands that modify files or
   access sensitive data.

3. NETWORK ACCESS
   The agent connects to external services (AI providers, messaging platforms).
   Ensure you trust all configured services and review their privacy policies.

4. DATA HANDLING
   Messages and data may be sent to external AI providers for processing.
   Do not share sensitive personal information through the agent.

5. YOUR RESPONSIBILITY
   You are responsible for:
   - Monitoring agent activities
   - Reviewing execution requests
   - Keeping your system and credentials secure
   - Complying with terms of service for all connected platforms

════════════════════════════════════════════════════════════════════════════════
`;

/**
 * Supported model providers.
 */
export const MODEL_PROVIDERS = [
	{ value: "anthropic", label: "Anthropic (Claude)", hint: "Recommended" },
	{ value: "openai", label: "OpenAI (GPT)", hint: "" },
	{ value: "google", label: "Google (Gemini)", hint: "" },
	{ value: "groq", label: "Groq", hint: "Fast inference" },
	{ value: "xai", label: "xAI (Grok)", hint: "" },
	{ value: "openrouter", label: "OpenRouter", hint: "Multi-provider" },
	{ value: "ollama", label: "Ollama", hint: "Local models" },
] as const;

/**
 * Supported channels.
 */
export const CHANNELS = [
	{ value: "discord", label: "Discord", hint: "Bot token required" },
	{ value: "telegram", label: "Telegram", hint: "Bot token required" },
	{ value: "twitter", label: "Twitter/X", hint: "Credentials required" },
	{ value: "slack", label: "Slack", hint: "Bot token required" },
	{ value: "web", label: "Web Interface", hint: "Built-in" },
] as const;

/**
 * Authentication methods.
 */
export const AUTH_METHODS = [
	{ value: "api_key", label: "API Key", hint: "Enter your API key directly" },
	{
		value: "oauth",
		label: "OAuth",
		hint: "Sign in with your provider account",
	},
	{
		value: "setup_token",
		label: "Setup Token",
		hint: "Paste token from CLI command",
	},
] as const;

/**
 * CLI Onboarding Adapter
 *
 * Provides CLI-specific functionality on top of the OnboardingStateMachine.
 */
export class CLIOnboardingAdapter {
	private stateMachine: OnboardingStateMachine;

	constructor(
		config?: Partial<Omit<OnboardingStateMachineConfig, "platform" | "mode">>,
	) {
		this.stateMachine = new OnboardingStateMachine({
			platform: "cli",
			mode: "cli",
			...config,
		});
	}

	/**
	 * Get the underlying state machine.
	 */
	getStateMachine(): OnboardingStateMachine {
		return this.stateMachine;
	}

	/**
	 * Get the current context.
	 */
	getContext(): OnboardingContext {
		return this.stateMachine.getContext();
	}

	/**
	 * Get the current step.
	 */
	getCurrentStep(): OnboardingStep {
		return this.stateMachine.getCurrentStep();
	}

	/**
	 * Get progress information.
	 */
	getProgress(): OnboardingProgress {
		return this.stateMachine.getProgress();
	}

	/**
	 * Generate appropriate CLI prompt(s) for the current step.
	 */
	promptForStep(step?: OnboardingStep): CliPromptConfig[] {
		const targetStep = step || this.stateMachine.getCurrentStep();

		switch (targetStep) {
			case OnboardingStep.WELCOME:
				return this.getWelcomePrompts();
			case OnboardingStep.RISK_ACK:
				return this.getRiskAckPrompts();
			case OnboardingStep.AUTH:
				return this.getAuthPrompts();
			case OnboardingStep.CHANNELS:
				return this.getChannelPrompts();
			case OnboardingStep.SKILLS:
				return this.getSkillsPrompts();
			case OnboardingStep.COMPLETE:
				return this.getCompletePrompts();
			default:
				return [];
		}
	}

	/**
	 * Parse CLI input for a specific step.
	 */
	parseCliInput(
		input: Record<string, unknown>,
		step?: OnboardingStep,
	): ParsedCliInput {
		const targetStep = step || this.stateMachine.getCurrentStep();

		switch (targetStep) {
			case OnboardingStep.WELCOME:
				return this.parseWelcomeInput(input);
			case OnboardingStep.RISK_ACK:
				return this.parseRiskAckInput(input);
			case OnboardingStep.AUTH:
				return this.parseAuthInput(input);
			case OnboardingStep.CHANNELS:
				return this.parseChannelsInput(input);
			case OnboardingStep.SKILLS:
				return this.parseSkillsInput(input);
			case OnboardingStep.COMPLETE:
				return {
					success: true,
					input: { step: OnboardingStep.COMPLETE, data: {} },
				};
			default:
				return { success: false, error: `Unknown step: ${targetStep}` };
		}
	}

	/**
	 * Process input and advance the state machine.
	 */
	async advanceStep(input: OnboardingInput): Promise<OnboardingResult> {
		return this.stateMachine.advanceStep(input);
	}

	/**
	 * Skip the current step.
	 */
	async skipStep(): Promise<OnboardingResult> {
		return this.stateMachine.skipStep();
	}

	/**
	 * Go back to a previous step.
	 */
	goBack(targetStep?: OnboardingStep): OnboardingResult {
		return this.stateMachine.goBack(targetStep);
	}

	/**
	 * Reset the onboarding flow.
	 */
	reset(): void {
		this.stateMachine.reset();
	}

	// ============================================================================
	// Step-Specific Prompt Generators
	// ============================================================================

	/**
	 * Get prompts for WELCOME step.
	 */
	private getWelcomePrompts(): CliPromptConfig[] {
		return [
			{
				title: "Welcome to Otto Setup",
				description: `Let's get your agent up and running. This wizard will guide you through:
        
• Authentication setup with AI providers
• Channel configuration (Discord, Telegram, etc.)
• Skills and capabilities setup

${ONBOARDING_STEP_DESCRIPTIONS[OnboardingStep.WELCOME]}`,
				type: "confirm",
				defaultValue: true,
			},
		];
	}

	/**
	 * Get prompts for RISK_ACK step.
	 */
	private getRiskAckPrompts(): CliPromptConfig[] {
		return [
			{
				title: ONBOARDING_STEP_LABELS[OnboardingStep.RISK_ACK],
				description: RISK_ACKNOWLEDGEMENT_TEXT,
				type: "confirm",
				defaultValue: false,
				required: true,
			},
		];
	}

	/**
	 * Get prompts for AUTH step.
	 */
	private getAuthPrompts(): CliPromptConfig[] {
		return [
			{
				title: "Select Model Provider",
				description: "Choose your AI model provider:",
				type: "select",
				options: MODEL_PROVIDERS.map((p) => ({
					value: p.value,
					label: p.label,
					hint: p.hint,
				})),
				defaultValue: "anthropic",
			},
			{
				title: "Authentication Method",
				description: "How would you like to authenticate?",
				type: "select",
				options: AUTH_METHODS.map((m) => ({
					value: m.value,
					label: m.label,
					hint: m.hint,
				})),
				defaultValue: "api_key",
			},
			{
				title: "API Key",
				description: "Enter your API key:",
				type: "password",
				placeholder: "sk-...",
				validate: (value) => {
					if (!value || value.trim().length < 10) {
						return "API key appears too short";
					}
					return undefined;
				},
				required: true,
			},
		];
	}

	/**
	 * Get prompts for CHANNELS step.
	 */
	private getChannelPrompts(): CliPromptConfig[] {
		return [
			{
				title: "Select Channels",
				description: "Which messaging channels would you like to enable?",
				type: "multiselect",
				options: CHANNELS.map((c) => ({
					value: c.value,
					label: c.label,
					hint: c.hint,
				})),
				defaultValue: [],
			},
		];
	}

	/**
	 * Get prompts for SKILLS step.
	 */
	private getSkillsPrompts(): CliPromptConfig[] {
		return [
			{
				title: "Package Manager",
				description: "Which Node.js package manager do you prefer?",
				type: "select",
				options: [
					{ value: "bun", label: "Bun", hint: "Recommended" },
					{ value: "pnpm", label: "pnpm", hint: "" },
					{ value: "npm", label: "npm", hint: "" },
				],
				defaultValue: "bun",
			},
			{
				title: "Install Homebrew Packages",
				description: "Allow installation of Homebrew packages for skills?",
				type: "confirm",
				defaultValue: true,
			},
		];
	}

	/**
	 * Get prompts for COMPLETE step.
	 */
	private getCompletePrompts(): CliPromptConfig[] {
		const context = this.stateMachine.getContext();
		const summary = this.generateCompletionSummary(context);

		return [
			{
				title: "Setup Complete!",
				description: summary,
				type: "confirm",
				defaultValue: true,
			},
		];
	}

	// ============================================================================
	// Step-Specific Input Parsers
	// ============================================================================

	/**
	 * Parse WELCOME step input.
	 */
	private parseWelcomeInput(input: Record<string, unknown>): ParsedCliInput {
		const acknowledged = input.acknowledged ?? input.confirm ?? true;

		return {
			success: true,
			input: {
				step: OnboardingStep.WELCOME,
				data: {
					acknowledged: Boolean(acknowledged),
					userName: input.userName as string | undefined,
				},
			},
		};
	}

	/**
	 * Parse RISK_ACK step input.
	 */
	private parseRiskAckInput(input: Record<string, unknown>): ParsedCliInput {
		const accepted = input.accepted ?? input.confirm ?? false;

		if (!accepted) {
			return {
				success: false,
				error: "Risk acknowledgement is required to continue",
			};
		}

		return {
			success: true,
			input: {
				step: OnboardingStep.RISK_ACK,
				data: {
					accepted: Boolean(accepted),
					warningText: RISK_ACKNOWLEDGEMENT_TEXT,
				},
			},
		};
	}

	/**
	 * Parse AUTH step input.
	 */
	private parseAuthInput(input: Record<string, unknown>): ParsedCliInput {
		// Check for skip
		if (input.skip) {
			return {
				success: true,
				input: {
					step: OnboardingStep.AUTH,
					data: {
						method: "api_key",
						skip: true,
					},
				},
			};
		}

		const method = (input.method ??
			input.authMethod ??
			"api_key") as AuthInput["method"];
		const provider = input.provider as string | undefined;

		const authData: AuthInput = {
			method,
			provider,
		};

		switch (method) {
			case "api_key":
				authData.apiKey = input.apiKey as string | undefined;
				if (!authData.apiKey && !input.skip) {
					return {
						success: false,
						error: "API key is required",
					};
				}
				break;

			case "setup_token":
				authData.setupToken = input.setupToken as string | undefined;
				if (!authData.setupToken) {
					return {
						success: false,
						error: "Setup token is required",
					};
				}
				break;

			case "oauth":
				if (input.oauthCode && input.oauthState) {
					authData.oauthCallback = {
						code: input.oauthCode as string,
						state: input.oauthState as string,
					};
				} else {
					return {
						success: false,
						error: "OAuth callback data is required",
					};
				}
				break;
		}

		return {
			success: true,
			input: {
				step: OnboardingStep.AUTH,
				data: authData,
			},
		};
	}

	/**
	 * Parse CHANNELS step input.
	 */
	private parseChannelsInput(input: Record<string, unknown>): ParsedCliInput {
		// Check for skip
		if (input.skip) {
			return {
				success: true,
				input: {
					step: OnboardingStep.CHANNELS,
					data: {
						channels: [],
						skip: true,
					},
				},
			};
		}

		// Parse selected channels
		const selectedChannels = (input.channels ??
			input.selected ??
			[]) as string[];
		const channelConfigs = (input.channelConfigs ?? {}) as Record<
			string,
			Record<string, string>
		>;

		const channels: ChannelsInput["channels"] = selectedChannels.map(
			(type) => ({
				type,
				enabled: true,
				credentials: channelConfigs[type],
			}),
		);

		// Parse DM policy
		const dmPolicy = input.dmPolicy as ChannelsInput["dmPolicy"];

		return {
			success: true,
			input: {
				step: OnboardingStep.CHANNELS,
				data: {
					channels,
					dmPolicy,
				},
			},
		};
	}

	/**
	 * Parse SKILLS step input.
	 */
	private parseSkillsInput(input: Record<string, unknown>): ParsedCliInput {
		// Check for skip
		if (input.skip) {
			return {
				success: true,
				input: {
					step: OnboardingStep.SKILLS,
					data: {
						skills: [],
						install: [],
						skip: true,
					},
				},
			};
		}

		const skills = (input.skills ?? input.enabledSkills ?? []) as string[];
		const install = (input.install ?? input.skillsToInstall ?? []) as string[];

		const preferences: SkillsInput["preferences"] = {};
		if (input.useHomebrew !== undefined) {
			preferences.useHomebrew = Boolean(input.useHomebrew);
		}
		if (input.nodeManager) {
			preferences.nodeManager = input.nodeManager as "npm" | "pnpm" | "bun";
		}

		return {
			success: true,
			input: {
				step: OnboardingStep.SKILLS,
				data: {
					skills,
					install,
					preferences,
				},
			},
		};
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

	/**
	 * Generate a completion summary.
	 */
	private generateCompletionSummary(context: OnboardingContext): string {
		const lines: string[] = [
			"Your agent has been configured successfully!\n",
			"Configuration Summary:",
			"═".repeat(50),
		];

		// Auth summary
		if (context.settings.auth) {
			const auth = context.settings.auth;
			lines.push(`\n📋 Authentication:`);
			lines.push(`   Provider: ${auth.modelProvider || "Not set"}`);
			lines.push(`   Method: ${auth.authMethod || "Not set"}`);
			if (auth.apiKey) {
				lines.push(`   API Key: ****${auth.apiKey.slice(-4)}`);
			}
		}

		// Channels summary
		if (context.settings.channels) {
			const channels = context.settings.channels;
			lines.push(`\n📡 Channels:`);
			if (channels.enabledChannels.length > 0) {
				lines.push(`   Enabled: ${channels.enabledChannels.join(", ")}`);
			} else {
				lines.push(`   No channels configured`);
			}
		}

		// Skills summary
		if (context.settings.skills) {
			const skills = context.settings.skills;
			lines.push(`\n🔧 Skills:`);
			if (skills.enabledSkills.length > 0) {
				lines.push(`   Enabled: ${skills.enabledSkills.join(", ")}`);
			}
			if (skills.nodeManager) {
				lines.push(`   Package Manager: ${skills.nodeManager}`);
			}
		}

		lines.push(`\n${"═".repeat(50)}`);
		lines.push("\nYour agent is ready to use! Run 'otto start' to begin.");

		return lines.join("\n");
	}

	/**
	 * Format a progress bar for CLI display.
	 */
	formatProgressBar(width = 30): string {
		const progress = this.stateMachine.getProgress();
		const filled = Math.round((progress.percentage / 100) * width);
		const empty = width - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		return `[${bar}] ${progress.percentage}% - ${progress.steps.find((s) => s.status === "current")?.label || "Complete"}`;
	}

	/**
	 * Get step-specific help text.
	 */
	getStepHelp(step?: OnboardingStep): string {
		const targetStep = step || this.stateMachine.getCurrentStep();

		switch (targetStep) {
			case OnboardingStep.WELCOME:
				return "Press Enter to continue with the setup wizard.";

			case OnboardingStep.RISK_ACK:
				return `Please read the security information carefully. You must accept to continue.
        
Type 'y' or 'yes' to accept, or 'n' or 'no' to decline.`;

			case OnboardingStep.AUTH:
				return `Choose your AI model provider and enter your API key.

Supported providers:
${MODEL_PROVIDERS.map((p) => `  - ${p.label}${p.hint ? ` (${p.hint})` : ""}`).join("\n")}

You can skip this step and configure authentication later.`;

			case OnboardingStep.CHANNELS:
				return `Select the messaging channels you want to enable.

Use arrow keys to navigate and Space to select/deselect.
Press Enter when done.

You can skip this step and add channels later.`;

			case OnboardingStep.SKILLS:
				return `Configure skills and capabilities for your agent.

Skills provide additional functionality like:
  - Shell command execution
  - Web browsing
  - File operations
  - And more...

You can install additional skills later.`;

			case OnboardingStep.COMPLETE:
				return "Setup is complete! Your agent is ready to use.";

			default:
				return "";
		}
	}
}

/**
 * Create a new CLI onboarding adapter.
 */
export function createCLIOnboardingAdapter(
	config?: Partial<Omit<OnboardingStateMachineConfig, "platform" | "mode">>,
): CLIOnboardingAdapter {
	return new CLIOnboardingAdapter(config);
}

/**
 * Run through CLI onboarding with provided answers (for testing/automation).
 */
export async function runNonInteractiveOnboarding(
	adapter: CLIOnboardingAdapter,
	answers: {
		provider?: string;
		apiKey?: string;
		channels?: string[];
		skills?: string[];
		nodeManager?: "npm" | "pnpm" | "bun";
	},
): Promise<OnboardingResult> {
	// Welcome
	let result = await adapter.advanceStep({
		step: OnboardingStep.WELCOME,
		data: { acknowledged: true },
	});
	if (!result.success) return result;

	// Risk Ack
	result = await adapter.advanceStep({
		step: OnboardingStep.RISK_ACK,
		data: { accepted: true },
	});
	if (!result.success) return result;

	// Auth
	if (answers.apiKey && answers.provider) {
		result = await adapter.advanceStep({
			step: OnboardingStep.AUTH,
			data: {
				method: "api_key",
				provider: answers.provider,
				apiKey: answers.apiKey,
			},
		});
	} else {
		result = await adapter.advanceStep({
			step: OnboardingStep.AUTH,
			data: { method: "api_key", skip: true },
		});
	}
	if (!result.success) return result;

	// Channels
	if (answers.channels && answers.channels.length > 0) {
		result = await adapter.advanceStep({
			step: OnboardingStep.CHANNELS,
			data: {
				channels: answers.channels.map((type) => ({ type, enabled: true })),
			},
		});
	} else {
		result = await adapter.advanceStep({
			step: OnboardingStep.CHANNELS,
			data: { channels: [], skip: true },
		});
	}
	if (!result.success) return result;

	// Skills
	result = await adapter.advanceStep({
		step: OnboardingStep.SKILLS,
		data: {
			skills: answers.skills || [],
			install: [],
			preferences: {
				nodeManager: answers.nodeManager,
			},
			skip: !answers.skills || answers.skills.length === 0,
		},
	});

	return result;
}
