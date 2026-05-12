/**
 * Onboarding Types
 *
 * Type definitions for the onboarding state machine that supports
 * both CLI and conversational (DM) onboarding flows.
 */

import type { Metadata, UUID } from "./primitives";

/**
 * Onboarding step identifiers.
 * These represent the discrete steps in the onboarding flow.
 */
export const OnboardingStep = {
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
	/** Onboarding complete */
	COMPLETE: "COMPLETE",
} as const;

export type OnboardingStep =
	(typeof OnboardingStep)[keyof typeof OnboardingStep];

/**
 * Ordered list of onboarding steps for progression.
 */
export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
	OnboardingStep.WELCOME,
	OnboardingStep.RISK_ACK,
	OnboardingStep.AUTH,
	OnboardingStep.CHANNELS,
	OnboardingStep.SKILLS,
	OnboardingStep.COMPLETE,
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
 * Complete settings collected during onboarding.
 */
export interface OnboardingSettings {
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
export interface OnboardingStepError {
	/** Error code */
	code: string;
	/** Human-readable error message */
	message: string;
	/** Step where the error occurred */
	step: OnboardingStep;
	/** Additional error details */
	details?: Record<string, unknown>;
	/** Timestamp when error occurred */
	timestamp: number;
}

/**
 * Context tracking the current state of onboarding.
 */
export interface OnboardingContext {
	/** Current onboarding step */
	currentStep: OnboardingStep;
	/** Steps that have been completed */
	completedSteps: OnboardingStep[];
	/** Collected settings */
	settings: OnboardingSettings;
	/** Errors encountered during onboarding */
	errors: OnboardingStepError[];
	/** When onboarding started */
	startedAt: number;
	/** Last activity timestamp */
	lastActivityAt: number;
	/** World ID (for DM onboarding) */
	worldId?: UUID;
	/** User ID being onboarded */
	userId?: UUID;
	/** Platform (discord, telegram, cli, etc.) */
	platform: string;
	/** Onboarding mode */
	mode: "cli" | "conversational" | "wizard";
	/** Session ID for tracking */
	sessionId: string;
	/** Whether onboarding was interrupted */
	interrupted?: boolean;
	/** Metadata for custom extensions */
	metadata?: Metadata;
}

/**
 * Input types for each onboarding step.
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
export type OnboardingInput =
	| { step: typeof OnboardingStep.WELCOME; data: WelcomeInput }
	| { step: typeof OnboardingStep.RISK_ACK; data: RiskAckInput }
	| { step: typeof OnboardingStep.AUTH; data: AuthInput }
	| { step: typeof OnboardingStep.CHANNELS; data: ChannelsInput }
	| { step: typeof OnboardingStep.SKILLS; data: SkillsInput }
	| { step: typeof OnboardingStep.COMPLETE; data: Record<string, never> };

/**
 * Result of advancing a step.
 */
export interface OnboardingResult {
	/** Whether the step was successfully processed */
	success: boolean;
	/** The new current step after processing */
	newStep: OnboardingStep;
	/** Whether onboarding is now complete */
	isComplete: boolean;
	/** Error if the step failed */
	error?: OnboardingStepError;
	/** Message to display to the user */
	message?: string;
	/** Updated context */
	context: OnboardingContext;
	/** Data returned from the step (e.g., validation results) */
	data?: Record<string, unknown>;
}

/**
 * Progress information for display.
 */
export interface OnboardingProgress {
	/** Current step number (1-indexed) */
	currentStepNumber: number;
	/** Total number of steps */
	totalSteps: number;
	/** Completion percentage (0-100) */
	percentage: number;
	/** List of step statuses */
	steps: Array<{
		step: OnboardingStep;
		label: string;
		status: "completed" | "current" | "pending" | "error";
		errorMessage?: string;
	}>;
	/** Estimated time remaining (in seconds) */
	estimatedTimeRemaining?: number;
}

/**
 * Serialized onboarding state for persistence.
 */
export interface SerializedOnboardingState {
	/** Version of the serialization format */
	version: number;
	/** The onboarding context */
	context: OnboardingContext;
	/** Checksum for integrity verification */
	checksum?: string;
}

/**
 * Labels for each onboarding step (for UI display).
 */
export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
	[OnboardingStep.WELCOME]: "Welcome",
	[OnboardingStep.RISK_ACK]: "Risk Acknowledgement",
	[OnboardingStep.AUTH]: "Authentication",
	[OnboardingStep.CHANNELS]: "Channels",
	[OnboardingStep.SKILLS]: "Skills",
	[OnboardingStep.COMPLETE]: "Complete",
};

/**
 * Descriptions for each onboarding step.
 */
export const ONBOARDING_STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
	[OnboardingStep.WELCOME]: "Introduction to the onboarding process",
	[OnboardingStep.RISK_ACK]:
		"Review and acknowledge security risks and responsibilities",
	[OnboardingStep.AUTH]: "Configure authentication with AI model providers",
	[OnboardingStep.CHANNELS]:
		"Set up messaging channels (Discord, Telegram, etc.)",
	[OnboardingStep.SKILLS]: "Configure agent skills and capabilities",
	[OnboardingStep.COMPLETE]: "Onboarding complete - agent is ready to use",
};

/**
 * Get the step index (0-indexed) for a given step.
 */
export function getStepIndex(step: OnboardingStep): number {
	return ONBOARDING_STEP_ORDER.indexOf(step);
}

/**
 * Get the next step in the sequence, or null if at the end.
 */
export function getNextStep(
	currentStep: OnboardingStep,
): OnboardingStep | null {
	const currentIndex = getStepIndex(currentStep);
	if (currentIndex === -1 || currentIndex >= ONBOARDING_STEP_ORDER.length - 1) {
		return null;
	}
	return ONBOARDING_STEP_ORDER[currentIndex + 1];
}

/**
 * Get the previous step in the sequence, or null if at the beginning.
 */
export function getPreviousStep(
	currentStep: OnboardingStep,
): OnboardingStep | null {
	const currentIndex = getStepIndex(currentStep);
	if (currentIndex <= 0) {
		return null;
	}
	return ONBOARDING_STEP_ORDER[currentIndex - 1];
}

/**
 * Check if a step has been completed in the given context.
 */
export function isStepCompleted(
	context: OnboardingContext,
	step: OnboardingStep,
): boolean {
	return context.completedSteps.includes(step);
}

/**
 * Calculate completion percentage from context.
 */
export function calculateProgress(context: OnboardingContext): number {
	const totalSteps = ONBOARDING_STEP_ORDER.length - 1; // Exclude COMPLETE step
	const completedCount = context.completedSteps.filter(
		(s) => s !== OnboardingStep.COMPLETE,
	).length;
	return Math.round((completedCount / totalSteps) * 100);
}
