/**
 * Setup Types
 *
 * Type definitions for the setup state machine that supports
 * both CLI and conversational (DM) setup flows.
 */

import type { Metadata, UUID } from "./primitives";

/**
 * Setup step identifiers.
 * These represent the discrete steps in the setup flow.
 */
export const SetupStep = {
	/** Initial welcome and introduction */
	WELCOME: "WELCOME",
	/** Risk acknowledgement - user must accept security warnings */
	RISK_ACK: "RISK_ACK",
	/** Authentication setup - API keys, OAuth, etc. */
	AUTH: "AUTH",
	/** Channel configuration - Discord, Telegram, etc. */
	CHANNELS: "CHANNELS",
	/** Skills setup - tools and capabilities */
	SKILLS: "SKILLS",
	/** Setup complete */
	COMPLETE: "COMPLETE",
} as const;

export type SetupStep = (typeof SetupStep)[keyof typeof SetupStep];

/**
 * Ordered list of setup steps for progression.
 */
export const SETUP_STEP_ORDER: SetupStep[] = [
	SetupStep.WELCOME,
	SetupStep.RISK_ACK,
	SetupStep.AUTH,
	SetupStep.CHANNELS,
	SetupStep.SKILLS,
	SetupStep.COMPLETE,
];

/**
 * Settings collected during the AUTH step.
 */
export interface AuthSettings {
	/** Primary model provider (anthropic, openai, google, etc.) */
	modelProvider?: string;
	/** API key for the selected provider */
	apiKey?: string;
	/** OAuth tokens if using OAuth flow */
	oauthTokens?: {
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
	};
	/** Setup token (e.g., from `claude setup-token`) */
	setupToken?: string;
	/** Authentication method used */
	authMethod?: "api_key" | "oauth" | "setup_token";
}

/**
 * Settings collected during the CHANNELS step.
 */
export interface ChannelSettings {
	/** Enabled channel types */
	enabledChannels: string[];
	/** Channel-specific configurations */
	channelConfigs: Record<string, ChannelConfig>;
	/** DM policy settings */
	dmPolicy?: {
		allowUnknownSenders?: boolean;
		requireApproval?: boolean;
	};
}

/**
 * Configuration for a specific channel.
 */
export interface ChannelConfig {
	/** Channel type (discord, telegram, etc.) */
	type: string;
	/** Whether the channel is enabled */
	enabled: boolean;
	/** Channel-specific credentials */
	credentials?: Record<string, string>;
	/** Additional channel settings */
	settings?: Record<string, string | boolean | number>;
}

/**
 * Settings collected during the SKILLS step.
 */
export interface SkillsSettings {
	/** Enabled skills */
	enabledSkills: string[];
	/** Skills to install */
	skillsToInstall: string[];
	/** Homebrew installation preference */
	useHomebrew?: boolean;
	/** Node package manager preference */
	nodeManager?: "npm" | "bun";
}

/**
 * Complete settings collected during setup.
 */
export interface SetupSettings {
	/** Auth step settings */
	auth?: AuthSettings;
	/** Channels step settings */
	channels?: ChannelSettings;
	/** Skills step settings */
	skills?: SkillsSettings;
	/** Risk acknowledgement timestamp */
	riskAcknowledgedAt?: number;
	/** Whether user acknowledged risks */
	riskAcknowledged?: boolean;
	/** Gateway configuration */
	gateway?: {
		mode: "local" | "remote";
		port?: number;
		bind?: string;
	};
}

/**
 * Error information for a specific step.
 */
export interface SetupStepError {
	/** Error code */
	code: string;
	/** Human-readable error message */
	message: string;
	/** Step where the error occurred */
	step: SetupStep;
	/** Additional error details */
	details?: Record<string, unknown>;
	/** Timestamp when error occurred */
	timestamp: number;
}

/**
 * Context tracking the current state of setup.
 */
export interface SetupContext {
	/** Current setup step */
	currentStep: SetupStep;
	/** Steps that have been completed */
	completedSteps: SetupStep[];
	/** Collected settings */
	settings: SetupSettings;
	/** Errors encountered during setup */
	errors: SetupStepError[];
	/** When setup started */
	startedAt: number;
	/** Last activity timestamp */
	lastActivityAt: number;
	/** World ID (for DM setup) */
	worldId?: UUID;
	/** User ID being onboarded */
	userId?: UUID;
	/** Platform (discord, telegram, cli, etc.) */
	platform: string;
	/** Setup mode */
	mode: "cli" | "conversational" | "setup";
	/** Session ID for tracking */
	sessionId: string;
	/** Whether setup was interrupted */
	interrupted?: boolean;
	/** Metadata for custom extensions */
	metadata?: Metadata;
}

/**
 * Input types for each setup step.
 */
export interface WelcomeInput {
	/** User's response to welcome message */
	acknowledged: boolean;
	/** User's name (optional) */
	userName?: string;
}

export interface RiskAckInput {
	/** Whether user accepted the risk warning */
	accepted: boolean;
	/** Text of the warning that was shown */
	warningText?: string;
}

export interface AuthInput {
	/** Auth method being used */
	method: "api_key" | "oauth" | "setup_token";
	/** Provider name */
	provider?: string;
	/** API key if using api_key method */
	apiKey?: string;
	/** OAuth callback data if using oauth method */
	oauthCallback?: {
		code: string;
		state: string;
	};
	/** Setup token if using setup_token method */
	setupToken?: string;
	/** Skip auth (use local models) */
	skip?: boolean;
}

export interface ChannelsInput {
	/** Channels to enable */
	channels: Array<{
		type: string;
		enabled: boolean;
		token?: string;
		credentials?: Record<string, string>;
		settings?: Record<string, string | boolean | number>;
	}>;
	/** DM policy configuration */
	dmPolicy?: {
		allowUnknownSenders?: boolean;
		requireApproval?: boolean;
	};
	/** Skip channels configuration */
	skip?: boolean;
}

export interface SkillsInput {
	/** Skills to enable */
	skills: string[];
	/** Skills to install */
	install: string[];
	/** Installation preferences */
	preferences?: {
		useHomebrew?: boolean;
		nodeManager?: "npm" | "bun";
	};
	/** Skip skills configuration */
	skip?: boolean;
}

/**
 * Union type for step-specific inputs.
 */
export type SetupInput =
	| { step: typeof SetupStep.WELCOME; data: WelcomeInput }
	| { step: typeof SetupStep.RISK_ACK; data: RiskAckInput }
	| { step: typeof SetupStep.AUTH; data: AuthInput }
	| { step: typeof SetupStep.CHANNELS; data: ChannelsInput }
	| { step: typeof SetupStep.SKILLS; data: SkillsInput }
	| { step: typeof SetupStep.COMPLETE; data: Record<string, never> };

/**
 * Result of advancing a step.
 */
export interface SetupResult {
	/** Whether the step was successfully processed */
	success: boolean;
	/** The new current step after processing */
	newStep: SetupStep;
	/** Whether setup is now complete */
	isComplete: boolean;
	/** Error if the step failed */
	error?: SetupStepError;
	/** Message to display to the user */
	message?: string;
	/** Updated context */
	context: SetupContext;
	/** Data returned from the step (e.g., validation results) */
	data?: Record<string, unknown>;
}

/**
 * Progress information for display.
 */
export interface SetupProgress {
	/** Current step number (1-indexed) */
	currentStepNumber: number;
	/** Total number of steps */
	totalSteps: number;
	/** Completion percentage (0-100) */
	percentage: number;
	/** List of step statuses */
	steps: Array<{
		step: SetupStep;
		label: string;
		status: "completed" | "current" | "pending" | "error";
		errorMessage?: string;
	}>;
	/** Estimated time remaining (in seconds) */
	estimatedTimeRemaining?: number;
}

/**
 * Serialized setup state for persistence.
 */
export interface SerializedSetupState {
	/** Version of the serialization format */
	version: number;
	/** The setup context */
	context: SetupContext;
	/** Checksum for integrity verification */
	checksum?: string;
}

/**
 * Labels for each setup step (for UI display).
 */
export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
	[SetupStep.WELCOME]: "Welcome",
	[SetupStep.RISK_ACK]: "Risk Acknowledgement",
	[SetupStep.AUTH]: "Authentication",
	[SetupStep.CHANNELS]: "Channels",
	[SetupStep.SKILLS]: "Skills",
	[SetupStep.COMPLETE]: "Complete",
};

/**
 * Descriptions for each setup step.
 */
export const SETUP_STEP_DESCRIPTIONS: Record<SetupStep, string> = {
	[SetupStep.WELCOME]: "Introduction to the setup process",
	[SetupStep.RISK_ACK]:
		"Review and acknowledge security risks and responsibilities",
	[SetupStep.AUTH]: "Configure authentication with AI model providers",
	[SetupStep.CHANNELS]: "Set up messaging channels (Discord, Telegram, etc.)",
	[SetupStep.SKILLS]: "Configure agent skills and capabilities",
	[SetupStep.COMPLETE]: "Setup complete - agent is ready to use",
};

/**
 * Get the step index (0-indexed) for a given step.
 */
export function getStepIndex(step: SetupStep): number {
	return SETUP_STEP_ORDER.indexOf(step);
}

/**
 * Get the next step in the sequence, or null if at the end.
 */
export function getNextStep(currentStep: SetupStep): SetupStep | null {
	const currentIndex = getStepIndex(currentStep);
	if (currentIndex === -1 || currentIndex >= SETUP_STEP_ORDER.length - 1) {
		return null;
	}
	return SETUP_STEP_ORDER[currentIndex + 1];
}

/**
 * Get the previous step in the sequence, or null if at the beginning.
 */
export function getPreviousStep(currentStep: SetupStep): SetupStep | null {
	const currentIndex = getStepIndex(currentStep);
	if (currentIndex <= 0) {
		return null;
	}
	return SETUP_STEP_ORDER[currentIndex - 1];
}

/**
 * Check if a step has been completed in the given context.
 */
export function isStepCompleted(
	context: SetupContext,
	step: SetupStep,
): boolean {
	return context.completedSteps.includes(step);
}

/**
 * Calculate completion percentage from context.
 */
export function calculateProgress(context: SetupContext): number {
	const totalSteps = SETUP_STEP_ORDER.length - 1; // Exclude COMPLETE step
	const completedCount = context.completedSteps.filter(
		(s) => s !== SetupStep.COMPLETE,
	).length;
	return Math.round((completedCount / totalSteps) * 100);
}
