/**
 * Onboarding RPC Methods
 *
 * Provides RPC methods for native apps (macOS, iOS) to interact with
 * the onboarding wizard programmatically.
 *
 * Methods:
 * - wizard.start: Start onboarding, returns initial state
 * - wizard.step: Advance to next step with input
 * - wizard.getState: Get current state
 * - wizard.cancel: Abort onboarding
 */

import { logger } from "../logger";
import {
	ONBOARDING_STEP_DESCRIPTIONS,
	ONBOARDING_STEP_LABELS,
	type OnboardingContext,
	type OnboardingInput,
	type OnboardingProgress,
	OnboardingStep,
	type SerializedOnboardingState,
} from "../types/onboarding";
import type { UUID } from "../types/primitives";
import {
	OnboardingStateMachine,
	type OnboardingStateMachineConfig,
} from "./onboarding-state";

/**
 * RPC method names.
 */
export const WIZARD_RPC_METHODS = {
	START: "wizard.start",
	STEP: "wizard.step",
	GET_STATE: "wizard.getState",
	CANCEL: "wizard.cancel",
	GO_BACK: "wizard.goBack",
	SKIP: "wizard.skip",
} as const;

/**
 * Parameters for wizard.start RPC.
 */
export interface WizardStartParams {
	/** World ID for context */
	worldId?: UUID;
	/** User ID being onboarded */
	userId?: UUID;
	/** Platform identifier */
	platform?: string;
	/** Restore from existing state if available */
	restoreState?: SerializedOnboardingState;
}

/**
 * Result of wizard.start RPC.
 */
export interface WizardStartResult {
	/** Whether start was successful */
	success: boolean;
	/** Session ID for subsequent calls */
	sessionId: string;
	/** Initial state */
	state: WizardState;
	/** Error message if failed */
	error?: string;
}

/**
 * Parameters for wizard.step RPC.
 */
export interface WizardStepParams {
	/** Session ID from wizard.start */
	sessionId: string;
	/** Input for the current step */
	input: OnboardingInput;
}

/**
 * Result of wizard.step RPC.
 */
export interface WizardStepResult {
	/** Whether step was successful */
	success: boolean;
	/** Updated state after step */
	state: WizardState;
	/** Error if step failed */
	error?: string;
	/** Message for the user */
	message?: string;
}

/**
 * Parameters for wizard.getState RPC.
 */
export interface WizardGetStateParams {
	/** Session ID from wizard.start */
	sessionId: string;
}

/**
 * Result of wizard.getState RPC.
 */
export interface WizardGetStateResult {
	/** Whether request was successful */
	success: boolean;
	/** Current state */
	state?: WizardState;
	/** Error if request failed */
	error?: string;
}

/**
 * Parameters for wizard.cancel RPC.
 */
export interface WizardCancelParams {
	/** Session ID from wizard.start */
	sessionId: string;
	/** Whether to save partial progress */
	saveProgress?: boolean;
}

/**
 * Result of wizard.cancel RPC.
 */
export interface WizardCancelResult {
	/** Whether cancel was successful */
	success: boolean;
	/** Serialized state if saveProgress was true */
	savedState?: SerializedOnboardingState;
	/** Error if cancel failed */
	error?: string;
}

/**
 * Parameters for wizard.goBack RPC.
 */
export interface WizardGoBackParams {
	/** Session ID from wizard.start */
	sessionId: string;
	/** Target step to go back to (optional, defaults to previous) */
	targetStep?: OnboardingStep;
}

/**
 * Parameters for wizard.skip RPC.
 */
export interface WizardSkipParams {
	/** Session ID from wizard.start */
	sessionId: string;
}

/**
 * Wizard state for RPC responses.
 */
export interface WizardState {
	/** Current step */
	currentStep: OnboardingStep;
	/** Step label for display */
	currentStepLabel: string;
	/** Step description */
	currentStepDescription: string;
	/** Progress information */
	progress: OnboardingProgress;
	/** Whether onboarding is complete */
	isComplete: boolean;
	/** Full context */
	context: OnboardingContext;
	/** Available actions for current step */
	availableActions: string[];
}

/**
 * Callback for wizard state changes (for WebSocket events).
 */
export type WizardStateChangeCallback = (
	sessionId: string,
	oldState: WizardState,
	newState: WizardState,
) => void;

/**
 * Onboarding RPC Service
 *
 * Manages wizard sessions and handles RPC calls from native apps.
 */
export class OnboardingRPCService {
	/** Active wizard sessions keyed by session ID */
	private sessions: Map<string, OnboardingStateMachine> = new Map();
	/** State change callbacks for WebSocket notifications */
	private stateChangeCallbacks: Set<WizardStateChangeCallback> = new Set();

	/**
	 * Register a callback for state changes.
	 */
	onStateChange(callback: WizardStateChangeCallback): () => void {
		this.stateChangeCallbacks.add(callback);
		return () => this.stateChangeCallbacks.delete(callback);
	}

	/**
	 * Notify all callbacks of a state change.
	 */
	private notifyStateChange(
		sessionId: string,
		oldState: WizardState,
		newState: WizardState,
	): void {
		for (const callback of this.stateChangeCallbacks) {
			try {
				callback(sessionId, oldState, newState);
			} catch (err) {
				logger.error(
					{ err, sessionId },
					"[OnboardingRPCService] Error in state change callback",
				);
			}
		}
	}

	/**
	 * Convert context to wizard state.
	 */
	private toWizardState(machine: OnboardingStateMachine): WizardState {
		const context = machine.getContext();
		const currentStep = context.currentStep;

		// Determine available actions based on current step
		const availableActions: string[] = ["cancel"];

		if (currentStep !== OnboardingStep.WELCOME) {
			availableActions.push("goBack");
		}

		if (
			currentStep !== OnboardingStep.WELCOME &&
			currentStep !== OnboardingStep.RISK_ACK &&
			currentStep !== OnboardingStep.COMPLETE
		) {
			availableActions.push("skip");
		}

		if (currentStep !== OnboardingStep.COMPLETE) {
			availableActions.push("advance");
		}

		return {
			currentStep,
			currentStepLabel: ONBOARDING_STEP_LABELS[currentStep],
			currentStepDescription: ONBOARDING_STEP_DESCRIPTIONS[currentStep],
			progress: machine.getProgress(),
			isComplete: currentStep === OnboardingStep.COMPLETE,
			context,
			availableActions,
		};
	}

	/**
	 * Handle wizard.start RPC.
	 */
	async start(params: WizardStartParams): Promise<WizardStartResult> {
		try {
			const config: OnboardingStateMachineConfig = {
				platform: params.platform || "wizard",
				mode: "wizard",
				worldId: params.worldId,
				userId: params.userId,
				onStepChange: (_oldStep, newStep, context) => {
					const machine = this.sessions.get(context.sessionId);
					if (machine) {
						const oldState = this.toWizardState(machine);
						// Need to create a temporary new state
						const newState = { ...oldState, currentStep: newStep };
						this.notifyStateChange(context.sessionId, oldState, newState);
					}
				},
			};

			let machine: OnboardingStateMachine;

			if (params.restoreState) {
				// Restore from existing state
				machine = OnboardingStateMachine.fromJSON(params.restoreState, config);
				logger.info(
					{ sessionId: machine.getContext().sessionId },
					"[OnboardingRPCService] Restored wizard session",
				);
			} else {
				// Create new session
				machine = new OnboardingStateMachine(config);
				logger.info(
					{ sessionId: machine.getContext().sessionId },
					"[OnboardingRPCService] Started new wizard session",
				);
			}

			const sessionId = machine.getContext().sessionId;
			this.sessions.set(sessionId, machine);

			return {
				success: true,
				sessionId,
				state: this.toWizardState(machine),
			};
		} catch (err) {
			logger.error({ err }, "[OnboardingRPCService] Error starting wizard");
			return {
				success: false,
				sessionId: "",
				state: {} as WizardState,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle wizard.step RPC.
	 */
	async step(params: WizardStepParams): Promise<WizardStepResult> {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as WizardState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toWizardState(machine);
			const result = await machine.advanceStep(params.input);
			const newState = this.toWizardState(machine);

			if (result.success) {
				this.notifyStateChange(params.sessionId, oldState, newState);
			}

			return {
				success: result.success,
				state: newState,
				error: result.error?.message,
				message: result.message,
			};
		} catch (err) {
			logger.error(
				{ err, sessionId: params.sessionId },
				"[OnboardingRPCService] Error processing step",
			);
			return {
				success: false,
				state: this.toWizardState(machine),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle wizard.getState RPC.
	 */
	getState(params: WizardGetStateParams): WizardGetStateResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		return {
			success: true,
			state: this.toWizardState(machine),
		};
	}

	/**
	 * Handle wizard.cancel RPC.
	 */
	cancel(params: WizardCancelParams): WizardCancelResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		let savedState: SerializedOnboardingState | undefined;

		if (params.saveProgress) {
			savedState = machine.toJSON();
		}

		// Clean up session
		this.sessions.delete(params.sessionId);
		logger.info(
			{ sessionId: params.sessionId, savedProgress: params.saveProgress },
			"[OnboardingRPCService] Cancelled wizard session",
		);

		return {
			success: true,
			savedState,
		};
	}

	/**
	 * Handle wizard.goBack RPC.
	 */
	goBack(params: WizardGoBackParams): WizardStepResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as WizardState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toWizardState(machine);
			const result = machine.goBack(params.targetStep);
			const newState = this.toWizardState(machine);

			if (result.success) {
				this.notifyStateChange(params.sessionId, oldState, newState);
			}

			return {
				success: result.success,
				state: newState,
				error: result.error?.message,
				message: result.message,
			};
		} catch (err) {
			logger.error(
				{ err, sessionId: params.sessionId },
				"[OnboardingRPCService] Error going back",
			);
			return {
				success: false,
				state: this.toWizardState(machine),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle wizard.skip RPC.
	 */
	async skip(params: WizardSkipParams): Promise<WizardStepResult> {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as WizardState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toWizardState(machine);
			const result = await machine.skipStep();
			const newState = this.toWizardState(machine);

			if (result.success) {
				this.notifyStateChange(params.sessionId, oldState, newState);
			}

			return {
				success: result.success,
				state: newState,
				error: result.error?.message,
				message: result.message,
			};
		} catch (err) {
			logger.error(
				{ err, sessionId: params.sessionId },
				"[OnboardingRPCService] Error skipping step",
			);
			return {
				success: false,
				state: this.toWizardState(machine),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Get all active session IDs.
	 */
	getActiveSessions(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Check if a session exists.
	 */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/**
	 * Clean up all sessions.
	 */
	dispose(): void {
		this.sessions.clear();
		this.stateChangeCallbacks.clear();
		logger.info("[OnboardingRPCService] Disposed all sessions");
	}
}

/**
 * Create a new OnboardingRPCService instance.
 */
export function createOnboardingRPCService(): OnboardingRPCService {
	return new OnboardingRPCService();
}

/**
 * Helper to create RPC method handlers for integration with existing RPC systems.
 */
export function createWizardRPCHandlers(service: OnboardingRPCService) {
	return {
		[WIZARD_RPC_METHODS.START]: async (params: WizardStartParams) =>
			service.start(params),
		[WIZARD_RPC_METHODS.STEP]: async (params: WizardStepParams) =>
			service.step(params),
		[WIZARD_RPC_METHODS.GET_STATE]: (params: WizardGetStateParams) =>
			service.getState(params),
		[WIZARD_RPC_METHODS.CANCEL]: (params: WizardCancelParams) =>
			service.cancel(params),
		[WIZARD_RPC_METHODS.GO_BACK]: (params: WizardGoBackParams) =>
			service.goBack(params),
		[WIZARD_RPC_METHODS.SKIP]: async (params: WizardSkipParams) =>
			service.skip(params),
	};
}
