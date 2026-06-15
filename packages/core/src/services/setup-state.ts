/**
 * Setup State Machine
 *
 * A state machine for setup that can be driven by CLI prompts
 * OR chat messages. Handles step transitions, validation, and persistence.
 */

import { v4 as uuidv4 } from "uuid";
import { logger } from "../logger";
import type { UUID } from "../types/primitives";
import {
	type AuthInput,
	type ChannelsInput,
	calculateProgress,
	getNextStep,
	getStepIndex,
	type RiskAckInput,
	SETUP_STEP_DESCRIPTIONS,
	SETUP_STEP_LABELS,
	SETUP_STEP_ORDER,
	type SerializedSetupState,
	type SetupContext,
	type SetupInput,
	type SetupProgress,
	type SetupResult,
	type SetupSettings,
	SetupStep,
	type SetupStepError,
	type SkillsInput,
	type WelcomeInput,
} from "../types/setup";

/** Current serialization version for state persistence */
const SERIALIZATION_VERSION = 1;

/**
 * Step handler function type.
 */
type StepHandler<T> = (data: T, context: SetupContext) => Promise<SetupResult>;

/**
 * Validation result for step input.
 */
interface ValidationResult {
	valid: boolean;
	error?: string;
	details?: Record<string, unknown>;
}

/**
 * Configuration options for the state machine.
 */
export interface SetupStateMachineConfig {
	/** Platform identifier (cli, discord, telegram, etc.) */
	platform: string;
	/** Setup mode */
	mode: "cli" | "conversational" | "setup";
	/** World ID for persistence */
	worldId?: UUID;
	/** User ID being onboarded */
	userId?: UUID;
	/** Optional existing context to restore from */
	existingContext?: SetupContext;
	/** Callback when step changes */
	onStepChange?: (
		oldStep: SetupStep,
		newStep: SetupStep,
		context: SetupContext,
	) => void | Promise<void>;
	/** Callback when setup completes */
	onComplete?: (context: SetupContext) => void | Promise<void>;
	/** Callback when an error occurs */
	onError?: (error: SetupStepError, context: SetupContext) => void;
}

/**
 * Setup State Machine.
 *
 * Manages the setup flow across CLI and conversational interfaces.
 * Supports step progression, validation, persistence, and event callbacks.
 *
 * @example
 * ```typescript
 * const machine = new SetupStateMachine({
 *   platform: 'cli',
 *   mode: 'cli',
 *   onComplete: (ctx) => console.log('Setup complete!')
 * });
 *
 * // Advance through steps
 * await machine.advanceStep({ step: SetupStep.WELCOME, data: { acknowledged: true } });
 * await machine.advanceStep({ step: SetupStep.RISK_ACK, data: { accepted: true } });
 * // ...
 * ```
 */
export class SetupStateMachine {
	private context: SetupContext;
	private config: SetupStateMachineConfig;
	private stepHandlers: Map<SetupStep, StepHandler<unknown>>;

	constructor(config: SetupStateMachineConfig) {
		this.config = config;
		this.stepHandlers = new Map();

		// Initialize or restore context
		if (config.existingContext) {
			this.context = { ...config.existingContext };
			this.context.lastActivityAt = Date.now();
		} else {
			this.context = this.createInitialContext();
		}

		// Register default step handlers
		this.registerDefaultHandlers();
	}

	/**
	 * Create the initial context for a new setup session.
	 */
	private createInitialContext(): SetupContext {
		return {
			currentStep: SetupStep.WELCOME,
			completedSteps: [],
			settings: {},
			errors: [],
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			worldId: this.config.worldId,
			userId: this.config.userId,
			platform: this.config.platform,
			mode: this.config.mode,
			sessionId: uuidv4(),
		};
	}

	/**
	 * Register the default step handlers.
	 */
	private registerDefaultHandlers(): void {
		this.stepHandlers.set(
			SetupStep.WELCOME,
			this.handleWelcome.bind(this) as StepHandler<unknown>,
		);
		this.stepHandlers.set(
			SetupStep.RISK_ACK,
			this.handleRiskAck.bind(this) as StepHandler<unknown>,
		);
		this.stepHandlers.set(
			SetupStep.AUTH,
			this.handleAuth.bind(this) as StepHandler<unknown>,
		);
		this.stepHandlers.set(
			SetupStep.CHANNELS,
			this.handleChannels.bind(this) as StepHandler<unknown>,
		);
		this.stepHandlers.set(
			SetupStep.SKILLS,
			this.handleSkills.bind(this) as StepHandler<unknown>,
		);
	}

	/**
	 * Get the current setup step.
	 */
	getCurrentStep(): SetupStep {
		return this.context.currentStep;
	}

	/**
	 * Get the full setup context.
	 */
	getContext(): SetupContext {
		return { ...this.context };
	}

	/**
	 * Get the current settings.
	 */
	getSettings(): SetupSettings {
		return { ...this.context.settings };
	}

	/**
	 * Check if we can advance from the current step.
	 */
	canAdvance(): boolean {
		const currentStep = this.context.currentStep;

		// Already complete
		if (currentStep === SetupStep.COMPLETE) {
			return false;
		}

		// Check if current step has errors that block advancement
		const currentStepErrors = this.context.errors.filter(
			(e) => e.step === currentStep,
		);
		if (currentStepErrors.length > 0) {
			// Allow retry if there's an error
			return true;
		}

		return true;
	}

	/**
	 * Get the completion progress.
	 */
	getProgress(): SetupProgress {
		const currentIndex = getStepIndex(this.context.currentStep);
		const totalSteps = SETUP_STEP_ORDER.length;

		const steps = SETUP_STEP_ORDER.map((step, index) => {
			let status: "completed" | "current" | "pending" | "error";

			if (this.context.completedSteps.includes(step)) {
				status = "completed";
			} else if (step === this.context.currentStep) {
				const hasError = this.context.errors.some((e) => e.step === step);
				status = hasError ? "error" : "current";
			} else if (index > currentIndex) {
				status = "pending";
			} else {
				status = "pending";
			}

			const errorMessage = this.context.errors.find(
				(e) => e.step === step,
			)?.message;

			return {
				step,
				label: SETUP_STEP_LABELS[step],
				status,
				errorMessage,
			};
		});

		return {
			currentStepNumber: currentIndex + 1,
			totalSteps,
			percentage: calculateProgress(this.context),
			steps,
		};
	}

	/**
	 * Process input and advance to the next step.
	 */
	async advanceStep(input: SetupInput): Promise<SetupResult> {
		const { step, data } = input;

		// Validate that we're processing the correct step
		if (step !== this.context.currentStep) {
			const error: SetupStepError = {
				code: "STEP_MISMATCH",
				message: `Cannot process step ${step} when current step is ${this.context.currentStep}`,
				step: this.context.currentStep,
				timestamp: Date.now(),
			};

			this.context.errors.push(error);
			this.config.onError?.(error, this.context);

			return {
				success: false,
				newStep: this.context.currentStep,
				isComplete: false,
				error,
				context: this.getContext(),
			};
		}

		// Get the handler for this step
		const handler = this.stepHandlers.get(step);
		if (!handler) {
			const error: SetupStepError = {
				code: "NO_HANDLER",
				message: `No handler registered for step ${step}`,
				step,
				timestamp: Date.now(),
			};

			this.context.errors.push(error);
			this.config.onError?.(error, this.context);

			return {
				success: false,
				newStep: this.context.currentStep,
				isComplete: false,
				error,
				context: this.getContext(),
			};
		}

		// Update last activity
		this.context.lastActivityAt = Date.now();

		// Clear previous errors for this step before retrying
		this.context.errors = this.context.errors.filter((e) => e.step !== step);

		try {
			// Execute the handler
			const result = await handler(data, this.context);

			// If successful, move to next step
			if (result.success) {
				const oldStep = this.context.currentStep;
				const nextStep = getNextStep(oldStep);

				// Mark current step as completed
				if (!this.context.completedSteps.includes(oldStep)) {
					this.context.completedSteps.push(oldStep);
				}

				// Move to next step
				if (nextStep) {
					this.context.currentStep = nextStep;

					// Trigger step change callback
					await this.config.onStepChange?.(oldStep, nextStep, this.context);
				}

				// Check if complete
				if (nextStep === SetupStep.COMPLETE) {
					// Mark COMPLETE as completed too
					if (!this.context.completedSteps.includes(SetupStep.COMPLETE)) {
						this.context.completedSteps.push(SetupStep.COMPLETE);
					}

					await this.config.onComplete?.(this.context);

					return {
						success: true,
						newStep: SetupStep.COMPLETE,
						isComplete: true,
						message: "Setup complete!",
						context: this.getContext(),
					};
				}

				return {
					success: true,
					newStep: nextStep || SetupStep.COMPLETE,
					isComplete: !nextStep,
					message: result.message,
					context: this.getContext(),
					data: result.data,
				};
			}

			// Handler returned failure
			return result;
		} catch (err) {
			const error: SetupStepError = {
				code: "HANDLER_ERROR",
				message: err instanceof Error ? err.message : String(err),
				step,
				timestamp: Date.now(),
				details: err instanceof Error ? { stack: err.stack } : undefined,
			};

			this.context.errors.push(error);
			this.config.onError?.(error, this.context);

			logger.error(
				{ err, step, context: this.context },
				"[SetupStateMachine] Error in step handler",
			);

			return {
				success: false,
				newStep: this.context.currentStep,
				isComplete: false,
				error,
				context: this.getContext(),
			};
		}
	}

	/**
	 * Skip the current step (if allowed).
	 */
	async skipStep(): Promise<SetupResult> {
		const currentStep = this.context.currentStep;

		// Some steps cannot be skipped
		const unskippableSteps: SetupStep[] = [
			SetupStep.WELCOME,
			SetupStep.RISK_ACK,
			SetupStep.COMPLETE,
		];

		if (unskippableSteps.includes(currentStep)) {
			const error: SetupStepError = {
				code: "CANNOT_SKIP",
				message: `Step ${currentStep} cannot be skipped`,
				step: currentStep,
				timestamp: Date.now(),
			};

			return {
				success: false,
				newStep: currentStep,
				isComplete: false,
				error,
				context: this.getContext(),
			};
		}

		// Create skip input based on step
		let input: SetupInput;
		switch (currentStep) {
			case SetupStep.AUTH:
				input = {
					step: SetupStep.AUTH,
					data: { method: "api_key", skip: true },
				};
				break;
			case SetupStep.CHANNELS:
				input = {
					step: SetupStep.CHANNELS,
					data: { channels: [], skip: true },
				};
				break;
			case SetupStep.SKILLS:
				input = {
					step: SetupStep.SKILLS,
					data: { skills: [], install: [], skip: true },
				};
				break;
			default: {
				const error: SetupStepError = {
					code: "INVALID_SKIP",
					message: `Cannot determine skip input for step ${currentStep}`,
					step: currentStep,
					timestamp: Date.now(),
				};
				return {
					success: false,
					newStep: currentStep,
					isComplete: false,
					error,
					context: this.getContext(),
				};
			}
		}

		return this.advanceStep(input);
	}

	/**
	 * Go back to a previous step.
	 */
	goBack(targetStep?: SetupStep): SetupResult {
		const currentIndex = getStepIndex(this.context.currentStep);

		// Determine target step
		let target: SetupStep;
		if (targetStep) {
			const targetIndex = getStepIndex(targetStep);
			if (targetIndex >= currentIndex || targetIndex < 0) {
				return {
					success: false,
					newStep: this.context.currentStep,
					isComplete: false,
					error: {
						code: "INVALID_TARGET",
						message: `Cannot go back to ${targetStep} from ${this.context.currentStep}`,
						step: this.context.currentStep,
						timestamp: Date.now(),
					},
					context: this.getContext(),
				};
			}
			target = targetStep;
		} else {
			// Go back one step
			if (currentIndex <= 0) {
				return {
					success: false,
					newStep: this.context.currentStep,
					isComplete: false,
					error: {
						code: "NO_PREVIOUS_STEP",
						message: "Already at the first step",
						step: this.context.currentStep,
						timestamp: Date.now(),
					},
					context: this.getContext(),
				};
			}
			target = SETUP_STEP_ORDER[currentIndex - 1];
		}

		const oldStep = this.context.currentStep;
		this.context.currentStep = target;

		// Remove the target step and any later steps from completed
		const targetIndex = getStepIndex(target);
		this.context.completedSteps = this.context.completedSteps.filter(
			(step) => getStepIndex(step) < targetIndex,
		);

		// Clear errors for steps we're revisiting
		this.context.errors = this.context.errors.filter(
			(e) => getStepIndex(e.step) < targetIndex,
		);

		this.context.lastActivityAt = Date.now();

		// Trigger step change callback
		this.config.onStepChange?.(oldStep, target, this.context);

		return {
			success: true,
			newStep: target,
			isComplete: false,
			message: `Returned to ${SETUP_STEP_LABELS[target]}`,
			context: this.getContext(),
		};
	}

	/**
	 * Serialize the current state for persistence.
	 */
	toJSON(): SerializedSetupState {
		return {
			version: SERIALIZATION_VERSION,
			context: this.getContext(),
		};
	}

	/**
	 * Restore state from a serialized representation.
	 */
	static fromJSON(
		serialized: SerializedSetupState,
		config: Omit<SetupStateMachineConfig, "existingContext">,
	): SetupStateMachine {
		if (serialized.version !== SERIALIZATION_VERSION) {
			logger.warn(
				{
					serializedVersion: serialized.version,
					expectedVersion: SERIALIZATION_VERSION,
				},
				"[SetupStateMachine] Version mismatch during restore",
			);
		}

		return new SetupStateMachine({
			...config,
			existingContext: serialized.context,
		});
	}

	/**
	 * Reset the state machine to the beginning.
	 */
	reset(): void {
		this.context = this.createInitialContext();
	}

	/**
	 * Register a custom handler for a step.
	 */
	registerHandler<T>(step: SetupStep, handler: StepHandler<T>): void {
		this.stepHandlers.set(step, handler as StepHandler<unknown>);
	}

	// ============================================================================
	// Default Step Handlers
	// ============================================================================

	/**
	 * Handle the WELCOME step.
	 */
	private async handleWelcome(
		data: WelcomeInput,
		context: SetupContext,
	): Promise<SetupResult> {
		if (!data.acknowledged) {
			return {
				success: false,
				newStep: SetupStep.WELCOME,
				isComplete: false,
				error: {
					code: "NOT_ACKNOWLEDGED",
					message: "Please acknowledge to continue",
					step: SetupStep.WELCOME,
					timestamp: Date.now(),
				},
				context: this.getContext(),
			};
		}

		if (data.userName) {
			context.metadata = {
				...context.metadata,
				userName: data.userName,
			};
		}

		return {
			success: true,
			newStep: SetupStep.RISK_ACK,
			isComplete: false,
			message: "Welcome acknowledged. Let's review the important information.",
			context: this.getContext(),
		};
	}

	/**
	 * Handle the RISK_ACK step.
	 */
	private async handleRiskAck(
		data: RiskAckInput,
		context: SetupContext,
	): Promise<SetupResult> {
		if (!data.accepted) {
			return {
				success: false,
				newStep: SetupStep.RISK_ACK,
				isComplete: false,
				error: {
					code: "RISK_NOT_ACCEPTED",
					message:
						"You must accept the risk acknowledgement to continue. This is required for your safety.",
					step: SetupStep.RISK_ACK,
					timestamp: Date.now(),
				},
				context: this.getContext(),
			};
		}

		// Record the acceptance
		context.settings.riskAcknowledged = true;
		context.settings.riskAcknowledgedAt = Date.now();

		return {
			success: true,
			newStep: SetupStep.AUTH,
			isComplete: false,
			message:
				"Risk acknowledgement accepted. Now let's set up authentication.",
			context: this.getContext(),
		};
	}

	/**
	 * Handle the AUTH step.
	 */
	private async handleAuth(
		data: AuthInput,
		context: SetupContext,
	): Promise<SetupResult> {
		// Allow skipping
		if (data.skip) {
			return {
				success: true,
				newStep: SetupStep.CHANNELS,
				isComplete: false,
				message: "Authentication skipped. You can configure this later.",
				context: this.getContext(),
			};
		}

		// Validate based on method
		const validation = this.validateAuthInput(data);
		if (!validation.valid) {
			return {
				success: false,
				newStep: SetupStep.AUTH,
				isComplete: false,
				error: {
					code: "AUTH_VALIDATION_FAILED",
					message: validation.error || "Invalid authentication input",
					step: SetupStep.AUTH,
					timestamp: Date.now(),
					details: validation.details,
				},
				context: this.getContext(),
			};
		}

		// Store auth settings
		context.settings.auth = {
			authMethod: data.method,
			modelProvider: data.provider,
		};

		if (data.method === "api_key" && data.apiKey) {
			context.settings.auth.apiKey = data.apiKey;
		} else if (data.method === "setup_token" && data.setupToken) {
			context.settings.auth.setupToken = data.setupToken;
		} else if (data.method === "oauth" && data.oauthCallback) {
			// OAuth tokens would be exchanged here
			context.settings.auth.oauthTokens = {
				accessToken: "", // Would be set after token exchange
			};
		}

		return {
			success: true,
			newStep: SetupStep.CHANNELS,
			isComplete: false,
			message: "Authentication configured. Now let's set up channels.",
			context: this.getContext(),
		};
	}

	/**
	 * Validate auth input.
	 */
	private validateAuthInput(data: AuthInput): ValidationResult {
		if (!data.method) {
			return { valid: false, error: "Authentication method is required" };
		}

		switch (data.method) {
			case "api_key":
				if (!data.skip && (!data.apiKey || data.apiKey.trim().length === 0)) {
					return { valid: false, error: "API key is required" };
				}
				// Basic format validation
				if (data.apiKey) {
					const key = data.apiKey.trim();
					// Check for obviously invalid formats
					if (key.length < 10) {
						return { valid: false, error: "API key appears too short" };
					}
				}
				break;

			case "setup_token":
				if (!data.setupToken || data.setupToken.trim().length === 0) {
					return { valid: false, error: "Setup token is required" };
				}
				break;

			case "oauth":
				if (!data.oauthCallback?.code || !data.oauthCallback.state) {
					return { valid: false, error: "OAuth callback data is partial" };
				}
				break;

			default:
				return { valid: false, error: `Unknown auth method: ${data.method}` };
		}

		return { valid: true };
	}

	/**
	 * Handle the CHANNELS step.
	 */
	private async handleChannels(
		data: ChannelsInput,
		context: SetupContext,
	): Promise<SetupResult> {
		// Allow skipping
		if (data.skip) {
			return {
				success: true,
				newStep: SetupStep.SKILLS,
				isComplete: false,
				message:
					"Channel configuration skipped. You can set up channels later.",
				context: this.getContext(),
			};
		}

		// Initialize channel settings
		context.settings.channels = {
			enabledChannels: [],
			channelConfigs: {},
		};

		// Process each channel
		for (const channel of data.channels) {
			if (channel.enabled) {
				context.settings.channels.enabledChannels.push(channel.type);
				context.settings.channels.channelConfigs[channel.type] = {
					type: channel.type,
					enabled: true,
					credentials: channel.credentials,
					settings: channel.settings,
				};
			}
		}

		// Store DM policy if provided
		if (data.dmPolicy) {
			context.settings.channels.dmPolicy = data.dmPolicy;
		}

		const enabledCount = context.settings.channels.enabledChannels.length;
		const message =
			enabledCount > 0
				? `${enabledCount} channel(s) configured. Now let's set up skills.`
				: "No channels configured. You can add them later.";

		return {
			success: true,
			newStep: SetupStep.SKILLS,
			isComplete: false,
			message,
			context: this.getContext(),
		};
	}

	/**
	 * Handle the SKILLS step.
	 */
	private async handleSkills(
		data: SkillsInput,
		context: SetupContext,
	): Promise<SetupResult> {
		// Allow skipping
		if (data.skip) {
			return {
				success: true,
				newStep: SetupStep.COMPLETE,
				isComplete: true,
				message: "Skills configuration skipped. Setup complete!",
				context: this.getContext(),
			};
		}

		// Initialize skills settings
		context.settings.skills = {
			enabledSkills: data.skills || [],
			skillsToInstall: data.install || [],
		};

		// Store installation preferences
		if (data.preferences) {
			context.settings.skills.useHomebrew = data.preferences.useHomebrew;
			context.settings.skills.nodeManager = data.preferences.nodeManager;
		}

		const enabledCount = context.settings.skills.enabledSkills.length;
		const installCount = context.settings.skills.skillsToInstall.length;

		let message = "Skills configuration complete.";
		if (enabledCount > 0) {
			message = `${enabledCount} skill(s) enabled.`;
		}
		if (installCount > 0) {
			message += ` ${installCount} skill(s) queued for installation.`;
		}
		message += " Setup complete!";

		return {
			success: true,
			newStep: SetupStep.COMPLETE,
			isComplete: true,
			message,
			context: this.getContext(),
		};
	}
}

/**
 * Create a new setup state machine with default configuration.
 */
export function createSetupStateMachine(
	config: Partial<SetupStateMachineConfig> & { platform: string },
): SetupStateMachine {
	return new SetupStateMachine({
		mode: "conversational",
		...config,
	});
}

/**
 * Check if an setup context is complete.
 */
export function isSetupComplete(context: SetupContext): boolean {
	return context.currentStep === SetupStep.COMPLETE;
}

/**
 * Get a summary of the setup context for display.
 */
export function getSetupSummary(context: SetupContext): string {
	const progress = calculateProgress(context);
	const stepLabel = SETUP_STEP_LABELS[context.currentStep];
	const stepDescription = SETUP_STEP_DESCRIPTIONS[context.currentStep];

	let summary = `## Setup Progress: ${progress}%\n\n`;
	summary += `**Current Step:** ${stepLabel}\n`;
	summary += `**Description:** ${stepDescription}\n\n`;

	if (context.completedSteps.length > 0) {
		summary += "**Completed Steps:**\n";
		for (const step of context.completedSteps) {
			summary += `- ${SETUP_STEP_LABELS[step]}\n`;
		}
		summary += "\n";
	}

	if (context.errors.length > 0) {
		summary += "**Errors:**\n";
		for (const error of context.errors) {
			summary += `- [${error.step}] ${error.message}\n`;
		}
	}

	return summary;
}
