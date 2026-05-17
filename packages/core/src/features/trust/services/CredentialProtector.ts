import { logger } from "../../../logger.ts";
import {
	type IAgentRuntime,
	Service,
	type UUID,
} from "../../../types/index.ts";

import { type SecurityContext, SecurityEventType } from "../types/security.ts";
import type { SecurityModule } from "./SecurityModule.ts";
import type { SecurityModuleServiceWrapper } from "./wrappers.ts";

export interface CredentialThreatDetection {
	detected: boolean;
	confidence: number; // 0-1
	threatType:
		| "credential_request"
		| "phishing"
		| "social_engineering"
		| "prompt_injection"
		| "none";
	sensitiveData: string[];
	recommendation: string;
}

export class CredentialProtector extends Service {
	static serviceType = "credential-protector:core" as const;

	capabilityDescription =
		"Detects and prevents credential theft attempts, protects sensitive data";

	private securityModule: SecurityModule | null = null;
	private readonly keywordPatternCache = new Map<string, RegExp>();

	private static normalizeForScan(input: string): string {
		return input.toLowerCase().replace(/[^a-z0-9]/g, "");
	}

	private static reverseString(input: string): string {
		return input.split("").reverse().join("");
	}

	// Comprehensive patterns for sensitive data
	private readonly SENSITIVE_PATTERNS = [
		// Authentication tokens
		{ pattern: /api[_\s-]?key/i, type: "api_key" },
		{ pattern: /api[_\s-]?token/i, type: "api_token" },
		{ pattern: /auth[_\s-]?token/i, type: "auth_token" },
		{ pattern: /access[_\s-]?token/i, type: "access_token" },
		{ pattern: /access[_\s-]?key/i, type: "access_key" },
		{ pattern: /client[_\s-]?secret/i, type: "client_secret" },
		{ pattern: /bearer[_\s-]?token/i, type: "bearer_token" },
		{ pattern: /jwt[_\s-]?token/i, type: "jwt_token" },
		{ pattern: /session[_\s-]?token/i, type: "session_token" },
		{ pattern: /ssh[_\s-]?key/i, type: "ssh_key" },
		{ pattern: /\.env/i, type: "environment_file" },

		// Passwords and secrets
		{ pattern: /password/i, type: "password" },
		{ pattern: /passwd/i, type: "password" },
		{ pattern: /secret[_\s-]?key/i, type: "secret_key" },
		{ pattern: /private[_\s-]?key/i, type: "private_key" },
		{ pattern: /encryption[_\s-]?key/i, type: "encryption_key" },

		// Cryptocurrency
		{ pattern: /seed[_\s-]?phrase/i, type: "seed_phrase" },
		{ pattern: /mnemonic[_\s-]?phrase/i, type: "mnemonic" },
		{ pattern: /wallet[_\s-]?(seed|phrase|key)/i, type: "wallet_credentials" },
		{ pattern: /private[_\s-]?wallet/i, type: "wallet_key" },
		{ pattern: /recovery[_\s-]?phrase/i, type: "recovery_phrase" },

		// Personal information
		{ pattern: /social[_\s-]?security/i, type: "ssn" },
		{ pattern: /credit[_\s-]?card/i, type: "credit_card" },
		{ pattern: /bank[_\s-]?account/i, type: "bank_account" },
		{ pattern: /routing[_\s-]?number/i, type: "routing_number" },

		// Account credentials
		{ pattern: /login[_\s-]?credentials/i, type: "login_credentials" },
		{ pattern: /account[_\s-]?(password|creds)/i, type: "account_credentials" },
		{ pattern: /2fa[_\s-]?code/i, type: "2fa_code" },
		{ pattern: /otp[_\s-]?code/i, type: "otp_code" },
		{ pattern: /verification[_\s-]?code/i, type: "verification_code" },
	];

	// Canonical sensitive terms for obfuscation-aware scanning.
	private readonly SENSITIVE_KEYWORDS: Array<{
		keyword: string;
		type: string;
	}> = [
		{ keyword: "api key", type: "api_key" },
		{ keyword: "apikey", type: "api_key" },
		{ keyword: "api token", type: "api_token" },
		{ keyword: "apitoken", type: "api_token" },
		{ keyword: "auth token", type: "auth_token" },
		{ keyword: "access token", type: "access_token" },
		{ keyword: "access key", type: "access_key" },
		{ keyword: "bearer token", type: "bearer_token" },
		{ keyword: "jwt token", type: "jwt_token" },
		{ keyword: "session token", type: "session_token" },
		{ keyword: "client secret", type: "client_secret" },
		{ keyword: "password", type: "password" },
		{ keyword: "passwd", type: "password" },
		{ keyword: "secret key", type: "secret_key" },
		{ keyword: "private key", type: "private_key" },
		{ keyword: "encryption key", type: "encryption_key" },
		{ keyword: "seed phrase", type: "seed_phrase" },
		{ keyword: "mnemonic phrase", type: "mnemonic" },
		{ keyword: "wallet seed", type: "wallet_credentials" },
		{ keyword: "wallet phrase", type: "wallet_credentials" },
		{ keyword: "wallet key", type: "wallet_credentials" },
		{ keyword: "recovery phrase", type: "recovery_phrase" },
		{ keyword: "social security", type: "ssn" },
		{ keyword: "credit card", type: "credit_card" },
		{ keyword: "bank account", type: "bank_account" },
		{ keyword: "routing number", type: "routing_number" },
		{ keyword: "login credentials", type: "login_credentials" },
		{ keyword: "account creds", type: "account_credentials" },
		{ keyword: "2fa code", type: "2fa_code" },
		{ keyword: "otp code", type: "otp_code" },
		{ keyword: "verification code", type: "verification_code" },
		{ keyword: "ssh key", type: "ssh_key" },
		{ keyword: "dotenv", type: "environment_file" },
	];

	// Request patterns that indicate credential theft
	private readonly THEFT_REQUEST_PATTERNS = [
		/(?:send|share|give|post|dm|message|provide|tell|show|reveal|disclose|paste|export|dump|leak|forward|hand[_\s-]?over)[_\s-]?(me|us)?[_\s-]?(your|the)?/i,
		/(?:need|require|want)[_\s-]?(me|us)?[_\s-]?(your|the)/i,
		/(?:what[_\s-]?is|where[_\s-]?is)[_\s-]?(your|the)/i,
		/send[_\s-]?(me|us)[_\s-]?(your|the)/i,
		/give[_\s-]?(me|us)[_\s-]?(your|the)/i,
		/share[_\s-]?(your|the)/i,
		/post[_\s-]?(your|the)/i,
		/dm[_\s-]?(me|us)[_\s-]?(your|the)/i,
		/provide[_\s-]?(your|the)/i,
		/tell[_\s-]?(me|us)[_\s-]?(your|the)/i,
		/show[_\s-]?(me|us)[_\s-]?(your|the)/i,
		/reveal[_\s-]?(your|the)/i,
		/disclose[_\s-]?(your|the)/i,
	];

	private readonly PROMPT_INJECTION_PATTERNS = [
		/ignore\s+(all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|context)/i,
		/disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|commands|rules)/i,
		/(?:new|override|updated?)\s+(?:system\s+)?instructions?/i,
		/system\s+override/i,
		/bypass\s+(?:all\s+)?(?:security|safety|checks|guardrails|filters)/i,
		/(?:reveal|show|print|output|dump)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|configuration)/i,
		/grant\s+(?:me\s+)?(?:admin|owner|root|all\s+permissions)/i,
		/elevate\s+(?:my\s+)?(?:permissions|privileges)/i,
		/you\s+are\s+now/i,
		/pretend\s+(?:you\s+are|to\s+be)/i,
	];

	// Legitimate context patterns (reduce false positives)
	private readonly LEGITIMATE_CONTEXTS = [
		/how[_\s-]?to[_\s-]?reset[_\s-]?password/i,
		/forgot[_\s-]?password/i,
		/password[_\s-]?requirements/i,
		/strong[_\s-]?password/i,
		/change[_\s-]?password/i,
		/update[_\s-]?password/i,
		/password[_\s-]?policy/i,
		/never[_\s-]?share[_\s-]?password/i,
		/keep[_\s-]?password[_\s-]?safe/i,
	];

	async initialize(
		_runtime: IAgentRuntime,
		securityModule: SecurityModule,
	): Promise<void> {
		this.securityModule = securityModule;
		logger.info("[CredentialProtector] Initialized");
	}

	async stop(): Promise<void> {
		logger.info("[CredentialProtector] Stopped");
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new CredentialProtector();
		// Access the inner SecurityModule from the wrapper
		const wrapper =
			runtime.getService<SecurityModuleServiceWrapper>("security-module");
		if (!wrapper) {
			throw new Error(
				"[CredentialProtector] SecurityModule service not available",
			);
		}
		await service.initialize(runtime, wrapper.securityModule);
		return service;
	}

	/**
	 * Scan message for credential theft attempts
	 */
	async scanForCredentialTheft(
		message: string,
		entityId: UUID,
		context: SecurityContext,
	): Promise<CredentialThreatDetection> {
		const lowercaseMessage = message.toLowerCase();

		// Check if it's in a legitimate context first
		if (this.isLegitimateContext(lowercaseMessage)) {
			return {
				detected: false,
				confidence: 0,
				threatType: "none",
				sensitiveData: [],
				recommendation: "Message appears to be in legitimate context",
			};
		}

		// Detect sensitive data mentions
		const detectedSensitive = this.detectSensitiveData(message);
		const hasTheftRequest = this.hasTheftRequest(message);
		const hasPromptInjection = this.hasPromptInjectionPattern(message);
		const phishing = this.hasPhishingIndicators(lowercaseMessage);
		const regexRiskSignals = [
			...(hasPromptInjection ? ["prompt_injection"] : []),
			...(hasTheftRequest && detectedSensitive.length > 0
				? ["credential_exfiltration"]
				: []),
			...(phishing && detectedSensitive.length > 0 ? ["phishing"] : []),
		];

		if (regexRiskSignals.length > 0) {
			const confidence = Math.min(
				0.85 + detectedSensitive.length * 0.04 + regexRiskSignals.length * 0.02,
				1,
			);

			await this.logThreatEvent(
				entityId,
				message,
				detectedSensitive,
				confidence,
				context,
			);

			return {
				detected: true,
				confidence,
				threatType: hasPromptInjection
					? "prompt_injection"
					: phishing
						? "phishing"
						: "credential_request",
				sensitiveData: detectedSensitive,
				recommendation:
					"SECURITY RISK DETECTED !!!! Reject this request and refuse to provide sensitive data or privileged access.",
			};
		}

		// Low confidence but still suspicious
		if (detectedSensitive.length > 0) {
			return {
				detected: true,
				confidence: 0.4,
				threatType: "social_engineering",
				sensitiveData: detectedSensitive,
				recommendation:
					"Monitor user activity for additional suspicious behavior",
			};
		}

		return {
			detected: false,
			confidence: 0,
			threatType: "none",
			sensitiveData: [],
			recommendation: "No credential threats detected",
		};
	}

	/**
	 * Protect sensitive data by redacting it
	 */
	async protectSensitiveData(content: string): Promise<string> {
		let protectedContent = content;

		// Redact sensitive patterns
		for (const { pattern, type } of this.SENSITIVE_PATTERNS) {
			protectedContent = protectedContent.replace(
				pattern,
				`[REDACTED:${type}]`,
			);
		}

		// Redact potential tokens (long alphanumeric strings)
		protectedContent = protectedContent.replace(
			/\b[A-Za-z0-9]{32,}\b/g,
			"[REDACTED:potential_token]",
		);

		// Redact credit card patterns
		protectedContent = protectedContent.replace(
			/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
			"[REDACTED:credit_card_number]",
		);

		// Redact SSN patterns
		protectedContent = protectedContent.replace(
			/\b\d{3}-\d{2}-\d{4}\b/g,
			"[REDACTED:ssn]",
		);

		return protectedContent;
	}

	/**
	 * Alert potential victims of credential theft
	 */
	async alertPotentialVictims(
		threatActor: UUID,
		victims: UUID[],
		threatDetails: CredentialThreatDetection,
	): Promise<void> {
		for (const victimId of victims) {
			await this.runtime.log({
				entityId: victimId,
				roomId: this.runtime.agentId,
				type: "security_alert",
				body: {
					message:
						"Security Alert: Someone attempted to request your credentials. Never share passwords, tokens, or seed phrases with anyone.",
					metadata: {
						alertType: "credential_theft_warning",
						threatActor,
						threatDetails: {
							confidence: threatDetails.confidence,
							sensitiveDataRequested: threatDetails.sensitiveData,
						},
						timestamp: Date.now(),
					},
				},
			});
		}

		logger.info(
			`[CredentialProtector] Alerted ${victims.length} potential victims of credential theft attempt by ${threatActor}`,
		);
	}

	/**
	 * Analyze a conversation for credential theft patterns
	 */
	async analyzeConversation(
		messages: Array<{ entityId: UUID; content: string; timestamp: number }>,
		context: SecurityContext,
	): Promise<{
		overallThreat: number;
		suspiciousEntities: UUID[];
		recommendations: string[];
	}> {
		const entityThreats = new Map<UUID, number>();
		const detectedThreats: CredentialThreatDetection[] = [];

		for (const message of messages) {
			const threat = await this.scanForCredentialTheft(
				message.content,
				message.entityId,
				context,
			);

			if (threat.detected) {
				detectedThreats.push(threat);
				const currentThreat = entityThreats.get(message.entityId) || 0;
				entityThreats.set(
					message.entityId,
					Math.max(currentThreat, threat.confidence),
				);
			}
		}

		const overallThreat =
			detectedThreats.length > 0
				? detectedThreats.reduce((sum, t) => sum + t.confidence, 0) /
					detectedThreats.length
				: 0;

		const suspiciousEntities = Array.from(entityThreats.entries())
			.filter(([, threat]) => threat > 0.5)
			.map(([entity]) => entity);

		const recommendations: string[] = [];
		if (overallThreat > 0.8) {
			recommendations.push(
				"Immediate action required: Multiple credential theft attempts detected",
			);
			recommendations.push("Consider temporary channel lockdown");
			recommendations.push(
				"Alert all users about ongoing credential theft campaign",
			);
		} else if (overallThreat > 0.5) {
			recommendations.push(
				"Elevated threat level: Monitor closely for escalation",
			);
			recommendations.push(
				"Warn users about potential credential theft attempts",
			);
		} else if (overallThreat > 0.2) {
			recommendations.push("Low-level threat detected: Continue monitoring");
		}

		return {
			overallThreat,
			suspiciousEntities,
			recommendations,
		};
	}

	/**
	 * Private helper methods
	 */

	private detectSensitiveData(message: string): string[] {
		const detected: string[] = [];
		const lowercaseMessage = message.toLowerCase();

		for (const { pattern, type } of this.SENSITIVE_PATTERNS) {
			if (pattern.test(lowercaseMessage)) {
				detected.push(type);
			}
		}

		for (const { keyword, type } of this.SENSITIVE_KEYWORDS) {
			if (this.containsKeywordVariant(message, keyword)) {
				detected.push(type);
			}
		}

		// Remove duplicates
		return Array.from(new Set(detected));
	}

	private hasTheftRequest(message: string): boolean {
		const lowercaseMessage = message.toLowerCase();
		if (
			this.THEFT_REQUEST_PATTERNS.some((pattern) =>
				pattern.test(lowercaseMessage),
			)
		) {
			return true;
		}

		const normalized = CredentialProtector.normalizeForScan(message);
		const requestPhrases = [
			"sendmeyour",
			"givemeyour",
			"shareyour",
			"revealyour",
			"discloseyour",
			"showmeyour",
			"tellmeyour",
			"providethe",
			"whatisyour",
			"whereisyour",
			"needyour",
			"requireyour",
			"dumpyour",
			"leakyour",
			"exportyour",
		];
		return requestPhrases.some(
			(phrase) =>
				normalized.includes(phrase) ||
				normalized.includes(CredentialProtector.reverseString(phrase)),
		);
	}

	private hasPromptInjectionPattern(message: string): boolean {
		const lowercaseMessage = message.toLowerCase();
		if (
			this.PROMPT_INJECTION_PATTERNS.some((pattern) =>
				pattern.test(lowercaseMessage),
			)
		) {
			return true;
		}

		const injectionKeywords = [
			"ignorepreviousinstructions",
			"disregardpriorinstructions",
			"systemoverride",
			"bypasssecurity",
			"jailbreak",
			"developermode",
			"promptleak",
			"promptinjection",
		];
		const normalized = CredentialProtector.normalizeForScan(message);
		return injectionKeywords.some(
			(keyword) =>
				normalized.includes(keyword) ||
				normalized.includes(CredentialProtector.reverseString(keyword)),
		);
	}

	private isLegitimateContext(message: string): boolean {
		return this.LEGITIMATE_CONTEXTS.some((pattern) => pattern.test(message));
	}

	private hasPhishingIndicators(message: string): boolean {
		const phishingKeywords = [
			"urgent",
			"verify account",
			"suspended",
			"click here",
			"limited time",
			"act now",
			"confirm identity",
			"claim reward",
			"wallet connect",
			"bit.ly",
			"tinyurl",
		];

		return phishingKeywords.some((keyword) => message.includes(keyword));
	}

	private getKeywordPattern(keyword: string): RegExp {
		const normalizedKeyword = CredentialProtector.normalizeForScan(keyword);
		const cached = this.keywordPatternCache.get(normalizedKeyword);
		if (cached) {
			return cached;
		}
		const pattern = new RegExp(
			normalizedKeyword.split("").join("[\\s_\\-.:/\\\\]*"),
			"i",
		);
		this.keywordPatternCache.set(normalizedKeyword, pattern);
		return pattern;
	}

	private containsKeywordVariant(message: string, keyword: string): boolean {
		const normalizedKeyword = CredentialProtector.normalizeForScan(keyword);
		if (!normalizedKeyword) {
			return false;
		}

		const normalizedMessage = CredentialProtector.normalizeForScan(message);
		const reversedKeyword =
			CredentialProtector.reverseString(normalizedKeyword);

		if (
			normalizedMessage.includes(normalizedKeyword) ||
			normalizedMessage.includes(reversedKeyword)
		) {
			return true;
		}

		if (this.getKeywordPattern(keyword).test(message)) {
			return true;
		}

		const tokens = message
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);
		return tokens.some(
			(token) =>
				token === normalizedKeyword ||
				CredentialProtector.reverseString(token) === normalizedKeyword,
		);
	}

	private async logThreatEvent(
		entityId: UUID,
		message: string,
		sensitiveData: string[],
		confidence: number,
		context: SecurityContext,
	): Promise<void> {
		if (this.securityModule) {
			await this.securityModule.logSecurityEvent({
				type: SecurityEventType.CREDENTIAL_THEFT_ATTEMPT,
				entityId,
				severity: confidence > 0.8 ? "critical" : "high",
				context,
				details: {
					message: await this.protectSensitiveData(message),
					sensitiveDataTypes: sensitiveData,
					confidence,
				},
			});
		}
	}
}
