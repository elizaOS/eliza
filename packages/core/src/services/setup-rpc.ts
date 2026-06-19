/**
 * Setup RPC Methods
 *
 * Provides RPC methods for native apps (macOS, iOS) to interact with
 * setup programmatically.
 *
 * Methods:
 * - setup.start: Start setup, returns initial state
 * - setup.step: Advance to next step with input
 * - setup.getState: Get current state
 * - setup.cancel: Abort setup
 */

import { logger } from "../logger";
import type { UUID } from "../types/primitives";
import {
	SETUP_STEP_DESCRIPTIONS,
	SETUP_STEP_LABELS,
	type SerializedSetupState,
	type SetupContext,
	type SetupInput,
	type SetupProgress,
	SetupStep,
} from "../types/setup";
import { SetupStateMachine, type SetupStateMachineConfig } from "./setup-state";

/**
 * RPC method names.
 */
export const SETUP_RPC_METHODS = {
	START: "setup.start",
	STEP: "setup.step",
	GET_STATE: "setup.getState",
	CANCEL: "setup.cancel",
	GO_BACK: "setup.goBack",
	SKIP: "setup.skip",
} as const;

/**
 * Parameters for setup.start RPC.
 */
export interface SetupStartParams {
	/** World ID for context */
	worldId?: UUID;
	/** User ID being onboarded */
	userId?: UUID;
	/** Platform identifier */
	platform?: string;
	/** Restore from existing state if available */
	restoreState?: SerializedSetupState;
}

/**
 * Result of setup.start RPC.
 */
export interface SetupStartResult {
	/** Whether start was successful */
	success: boolean;
	/** Session ID for subsequent calls */
	sessionId: string;
	/** Initial state */
	state: SetupRpcState;
	/** Error message if failed */
	error?: string;
}

/**
 * Parameters for setup.step RPC.
 */
export interface SetupStepParams {
	/** Session ID from setup.start */
	sessionId: string;
	/** Input for the current step */
	input: SetupInput;
}

/**
 * Result of setup.step RPC.
 */
export interface SetupStepResult {
	/** Whether step was successful */
	success: boolean;
	/** Updated state after step */
	state: SetupRpcState;
	/** Error if step failed */
	error?: string;
	/** Message for the user */
	message?: string;
}

/**
 * Parameters for setup.getState RPC.
 */
export interface SetupGetStateParams {
	/** Session ID from setup.start */
	sessionId: string;
}

/**
 * Result of setup.getState RPC.
 */
export interface SetupGetStateResult {
	/** Whether request was successful */
	success: boolean;
	/** Current state */
	state?: SetupRpcState;
	/** Error if request failed */
	error?: string;
}

/**
 * Parameters for setup.cancel RPC.
 */
export interface SetupCancelParams {
	/** Session ID from setup.start */
	sessionId: string;
	/** Whether to save partial progress */
	saveProgress?: boolean;
}

/**
 * Result of setup.cancel RPC.
 */
export interface SetupCancelResult {
	/** Whether cancel was successful */
	success: boolean;
	/** Serialized state if saveProgress was true */
	savedState?: SerializedSetupState;
	/** Error if cancel failed */
	error?: string;
}

/**
 * Parameters for setup.goBack RPC.
 */
export interface SetupGoBackParams {
	/** Session ID from setup.start */
	sessionId: string;
	/** Target step to go back to (optional, defaults to previous) */
	targetStep?: SetupStep;
}

/**
 * Parameters for setup.skip RPC.
 */
export interface SetupSkipParams {
	/** Session ID from setup.start */
	sessionId: string;
}

/**
 * Setup state for RPC responses.
 */
export interface SetupRpcState {
	/** Current step */
	currentStep: SetupStep;
	/** Step label for display */
	currentStepLabel: string;
	/** Step description */
	currentStepDescription: string;
	/** Progress information */
	progress: SetupProgress;
	/** Whether setup is complete */
	isComplete: boolean;
	/** Full context */
	context: SetupContext;
	/** Available actions for current step */
	availableActions: string[];
}

/**
 * Callback for setup state changes (for WebSocket events).
 */
export type SetupRpcStateChangeCallback = (
	sessionId: string,
	oldState: SetupRpcState,
	newState: SetupRpcState,
) => void;

/**
 * Setup RPC Service
 *
 * Manages setup sessions and handles RPC calls from native apps.
 */
export class SetupRPCService {
	/** Active setup sessions keyed by session ID */
	private sessions: Map<string, SetupStateMachine> = new Map();
	/** State change callbacks for WebSocket notifications */
	private stateChangeCallbacks: Set<SetupRpcStateChangeCallback> = new Set();

	/**
	 * Register a callback for state changes.
	 */
	onStateChange(callback: SetupRpcStateChangeCallback): () => void {
		this.stateChangeCallbacks.add(callback);
		return () => this.stateChangeCallbacks.delete(callback);
	}

	/**
	 * Notify all callbacks of a state change.
	 */
	private notifyStateChange(
		sessionId: string,
		oldState: SetupRpcState,
		newState: SetupRpcState,
	): void {
		for (const callback of this.stateChangeCallbacks) {
			try {
				callback(sessionId, oldState, newState);
			} catch (err) {
				logger.error(
					{ err, sessionId },
					"[SetupRPCService] Error in state change callback",
				);
			}
		}
	}

	/**
	 * Convert context to setup state.
	 */
	private toSetupRpcState(machine: SetupStateMachine): SetupRpcState {
		const context = machine.getContext();
		const currentStep = context.currentStep;

		// Determine available actions based on current step
		const availableActions: string[] = ["cancel"];

		if (currentStep !== SetupStep.WELCOME) {
			availableActions.push("goBack");
		}

		if (
			currentStep !== SetupStep.WELCOME &&
			currentStep !== SetupStep.RISK_ACK &&
			currentStep !== SetupStep.COMPLETE
		) {
			availableActions.push("skip");
		}

		if (currentStep !== SetupStep.COMPLETE) {
			availableActions.push("advance");
		}

		return {
			currentStep,
			currentStepLabel: SETUP_STEP_LABELS[currentStep],
			currentStepDescription: SETUP_STEP_DESCRIPTIONS[currentStep],
			progress: machine.getProgress(),
			isComplete: currentStep === SetupStep.COMPLETE,
			context,
			availableActions,
		};
	}

	/**
	 * Handle setup.start RPC.
	 */
	async start(params: SetupStartParams): Promise<SetupStartResult> {
		try {
			const config: SetupStateMachineConfig = {
				platform: params.platform || "setup",
				mode: "setup",
				worldId: params.worldId,
				userId: params.userId,
				onStepChange: (_oldStep, newStep, context) => {
					const machine = this.sessions.get(context.sessionId);
					if (machine) {
						const oldState = this.toSetupRpcState(machine);
						// Need to create a temporary new state
						const newState = { ...oldState, currentStep: newStep };
						this.notifyStateChange(context.sessionId, oldState, newState);
					}
				},
			};

			let machine: SetupStateMachine;

			if (params.restoreState) {
				// Restore from existing state
				machine = SetupStateMachine.fromJSON(params.restoreState, config);
				logger.info(
					{ sessionId: machine.getContext().sessionId },
					"[SetupRPCService] Restored setup session",
				);
			} else {
				// Create new session
				machine = new SetupStateMachine(config);
				logger.info(
					{ sessionId: machine.getContext().sessionId },
					"[SetupRPCService] Started new setup session",
				);
			}

			const sessionId = machine.getContext().sessionId;
			this.sessions.set(sessionId, machine);

			return {
				success: true,
				sessionId,
				state: this.toSetupRpcState(machine),
			};
		} catch (err) {
			logger.error({ err }, "[SetupRPCService] Error starting setup");
			return {
				success: false,
				sessionId: "",
				state: {} as SetupRpcState,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle setup.step RPC.
	 */
	async step(params: SetupStepParams): Promise<SetupStepResult> {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as SetupRpcState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toSetupRpcState(machine);
			const result = await machine.advanceStep(params.input);
			const newState = this.toSetupRpcState(machine);

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
				"[SetupRPCService] Error processing step",
			);
			return {
				success: false,
				state: this.toSetupRpcState(machine),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle setup.getState RPC.
	 */
	getState(params: SetupGetStateParams): SetupGetStateResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		return {
			success: true,
			state: this.toSetupRpcState(machine),
		};
	}

	/**
	 * Handle setup.cancel RPC.
	 */
	cancel(params: SetupCancelParams): SetupCancelResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		let savedState: SerializedSetupState | undefined;

		if (params.saveProgress) {
			savedState = machine.toJSON();
		}

		// Clean up session
		this.sessions.delete(params.sessionId);
		logger.info(
			{ sessionId: params.sessionId, savedProgress: params.saveProgress },
			"[SetupRPCService] Cancelled setup session",
		);

		return {
			success: true,
			savedState,
		};
	}

	/**
	 * Handle setup.goBack RPC.
	 */
	goBack(params: SetupGoBackParams): SetupStepResult {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as SetupRpcState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toSetupRpcState(machine);
			const result = machine.goBack(params.targetStep);
			const newState = this.toSetupRpcState(machine);

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
				"[SetupRPCService] Error going back",
			);
			return {
				success: false,
				state: this.toSetupRpcState(machine),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Handle setup.skip RPC.
	 */
	async skip(params: SetupSkipParams): Promise<SetupStepResult> {
		const machine = this.sessions.get(params.sessionId);
		if (!machine) {
			return {
				success: false,
				state: {} as SetupRpcState,
				error: `Session not found: ${params.sessionId}`,
			};
		}

		try {
			const oldState = this.toSetupRpcState(machine);
			const result = await machine.skipStep();
			const newState = this.toSetupRpcState(machine);

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
				"[SetupRPCService] Error skipping step",
			);
			return {
				success: false,
				state: this.toSetupRpcState(machine),
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
		logger.info("[SetupRPCService] Disposed all sessions");
	}
}

/**
 * Create a new SetupRPCService instance.
 */
export function createSetupRPCService(): SetupRPCService {
	return new SetupRPCService();
}

/**
 * Helper to create RPC method handlers for integration with existing RPC systems.
 */
export function createSetupRPCHandlers(service: SetupRPCService) {
	return {
		[SETUP_RPC_METHODS.START]: async (params: SetupStartParams) =>
			service.start(params),
		[SETUP_RPC_METHODS.STEP]: async (params: SetupStepParams) =>
			service.step(params),
		[SETUP_RPC_METHODS.GET_STATE]: (params: SetupGetStateParams) =>
			service.getState(params),
		[SETUP_RPC_METHODS.CANCEL]: (params: SetupCancelParams) =>
			service.cancel(params),
		[SETUP_RPC_METHODS.GO_BACK]: (params: SetupGoBackParams) =>
			service.goBack(params),
		[SETUP_RPC_METHODS.SKIP]: async (params: SetupSkipParams) =>
			service.skip(params),
	};
}
