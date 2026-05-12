import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { Conviction, SupportedChain } from "../types";
import {
	type SimulatedActorV2,
	SimulationActorsServiceV2,
} from "./simulationActorsV2";
import {
	type TokenScenario as TokenScenarioInterface,
	TokenSimulationService,
} from "./tokenSimulationService";

// Create enum from the token scenario types
export enum TokenScenario {
	RUG_PULL_FAST = "rug_fast",
	RUG_PULL_SLOW = "rug_slow",
	SCAM_TOKEN = "scam",
	RUNNER_MOON = "runner_moon",
	RUNNER_STEADY = "runner_steady",
	SUCCESSFUL = "successful",
	MEDIOCRE = "mediocre",
	STAGNANT = "stagnant",
	BLUE_CHIP = "bluechip",
	PUMP_AND_DUMP = "pump_dump",
	SLOW_BLEED = "slow_bleed",
}

// Define the price data structure
export interface TokenPrice {
	timestamp: Date;
	price: number;
	volume: number;
	liquidity: number;
	marketCap: number;
}

// Actor configuration for simulation
export interface ActorConfig {
	id: UUID;
	username: string;
	archetype:
		| "elite_analyst"
		| "skilled_trader"
		| "pump_chaser"
		| "rug_promoter"
		| "fomo_trader"
		| "contrarian"
		| "technical_analyst"
		| "newbie"
		| "bot_spammer";
	expectedTrustScore: number;
	tokenPreferences: TokenScenario[];
	callFrequency: "high" | "medium" | "low";
	timingBias: "early" | "middle" | "late" | "random";
}

// Types matching the real EnrichedCallData format
export interface SimulatedCallData {
	callId: UUID;
	originalMessageId: string;
	userId: string;
	username: string;
	timestamp: number;
	content: string;
	nameMentioned?: string;
	tokenMentioned?: string;
	caMentioned?: string;
	chain: SupportedChain | "unknown";
	sentiment: "positive" | "negative" | "neutral";
	conviction: Conviction;
	llmReasoning: string;
	certainty: "high" | "medium" | "low";
	fileSource: string;
	// Simulation metadata
	simulationMetadata: {
		tokenScenario: TokenScenario;
		actorArchetype: string;
		priceAtCall: number;
		marketCapAtCall: number;
		liquidityAtCall: number;
		expectedOutcome: "profit" | "loss" | "neutral";
		actualProfit?: number; // Calculated at end of simulation
	};
}

export interface SimulationToken {
	address: string;
	symbol: string;
	name: string;
	scenario: TokenScenario;
	launchTime: Date;
	initialPrice: number;
	initialMarketCap: number;
	initialLiquidity: number;
	priceTrajectory?: (step: number) => number;
}

export interface SimulationConfig {
	// Time settings
	startTime: Date;
	endTime: Date;
	timeStepMinutes: number;

	// Token generation
	tokenCount: number;
	tokenScenarioDistribution?: Partial<Record<TokenScenario, number>>; // Weights

	// Actor configuration
	actors: ActorConfig[];

	// Output settings
	outputDir: string;
	cacheResults: boolean;
}

export interface SimulationResult {
	calls: SimulatedCallData[];
	tokens: Map<string, SimulationToken>;
	priceHistory: Map<string, TokenPrice[]>;
	actorPerformance: Map<
		string,
		{
			totalCalls: number;
			profitableCalls: number;
			totalProfit: number;
			averageProfit: number;
			trustScore?: number;
		}
	>;
}

export class SimulationRunner {
	private tokenService: TokenSimulationService;

	constructor() {
		this.tokenService = new TokenSimulationService();
		this.actorsService = new SimulationActorsServiceV2();
	}

	async runSimulation(config: SimulationConfig): Promise<SimulationResult> {
		console.log("🚀 Starting comprehensive market simulation...");

		// Initialize result containers
		const calls: SimulatedCallData[] = [];
		const tokens = new Map<string, SimulationToken>();
		const priceHistory = new Map<string, TokenPrice[]>();
		const actorPerformance = new Map<string, any>();

		// Initialize actors
		for (const actor of config.actors) {
			// Convert ActorConfig to SimulatedActorV2
			const _simulatedActor: SimulatedActorV2 = {
				id: actor.id,
				username: actor.username,
				archetype: actor.archetype,
				trustScore: actor.expectedTrustScore,
				callHistory: [],
				preferences: {
					favoriteTokenTypes: this.mapScenarioToTypes(actor.tokenPreferences),
					callFrequency: actor.callFrequency,
					timingBias: actor.timingBias,
				},
			};

			actorPerformance.set(actor.id, {
				totalCalls: 0,
				profitableCalls: 0,
				totalProfit: 0,
				averageProfit: 0,
			});
		}

		// Generate tokens with scenarios
		const generatedTokens = this.generateTokens(config);
		for (const token of generatedTokens) {
			tokens.set(token.address, token);
			priceHistory.set(token.address, []);
		}

		// Run simulation time steps
		let currentTime = new Date(config.startTime);
		const endTime = new Date(config.endTime);
		let stepCount = 0;

		while (currentTime <= endTime) {
			stepCount++;

			// Update token prices for current time
			for (const [address, token] of tokens) {
				const timeSinceLaunch =
					(currentTime.getTime() - token.launchTime.getTime()) /
					(1000 * 60 * 60);

				if (timeSinceLaunch >= 0) {
					const price = this.calculateTokenPrice(token, timeSinceLaunch);

					priceHistory.get(address)?.push({
						timestamp: currentTime,
						price: price.price,
						volume: price.volume,
						liquidity: price.liquidity,
						marketCap: price.marketCap,
					});
				}
			}

			// Generate actor calls for this time step
			const stepCalls = this.generateCallsForTimeStep(
				currentTime,
				tokens,
				priceHistory,
				config,
			);

			calls.push(...stepCalls);

			// Advance time
			currentTime = new Date(
				currentTime.getTime() + config.timeStepMinutes * 60 * 1000,
			);
		}

		console.log(
			`✅ Simulation complete: ${stepCount} time steps, ${calls.length} calls generated`,
		);

		// Calculate actual profits for each call
		await this.calculateActualProfits(calls, tokens, priceHistory);

		// Update actor performance metrics
		for (const call of calls) {
			const perf = actorPerformance.get(call.userId)!;
			perf.totalCalls++;

			if (
				call.simulationMetadata.actualProfit &&
				call.simulationMetadata.actualProfit > 0
			) {
				perf.profitableCalls++;
			}

			perf.totalProfit += call.simulationMetadata.actualProfit || 0;
		}

		// Calculate average profits
		for (const [_actorId, perf] of actorPerformance) {
			perf.averageProfit =
				perf.totalCalls > 0 ? perf.totalProfit / perf.totalCalls : 0;
		}

		const result: SimulationResult = {
			calls,
			tokens,
			priceHistory,
			actorPerformance,
		};

		// Cache results if requested
		if (config.cacheResults) {
			await this.cacheResults(result, config);
		}

		return result;
	}

	private calculateTokenPrice(
		token: SimulationToken,
		hoursSinceLaunch: number,
	): TokenPrice {
		// Use price trajectory if available
		let price = token.initialPrice;
		if (token.priceTrajectory) {
			// Convert hours to steps (assuming 1 step = 1 day)
			const step = Math.floor(hoursSinceLaunch / 24);
			price = token.priceTrajectory(step);
		}

		// Calculate other metrics based on price movement
		const priceRatio = price / token.initialPrice;
		const marketCap = token.initialMarketCap * priceRatio;
		const liquidity = token.initialLiquidity * Math.sqrt(priceRatio); // Liquidity grows slower
		const volume = marketCap * 0.1 * (1 + Math.random() * 0.5); // 10-15% of market cap

		return {
			timestamp: new Date(),
			price,
			volume,
			liquidity,
			marketCap,
		};
	}

	private mapScenarioToTypes(
		scenarios: TokenScenario[],
	): TokenScenarioInterface["type"][] {
		const mapping: Record<TokenScenario, TokenScenarioInterface["type"]> = {
			[TokenScenario.RUG_PULL_FAST]: "rug",
			[TokenScenario.RUG_PULL_SLOW]: "rug",
			[TokenScenario.SCAM_TOKEN]: "scam",
			[TokenScenario.RUNNER_MOON]: "runner",
			[TokenScenario.RUNNER_STEADY]: "runner",
			[TokenScenario.SUCCESSFUL]: "successful",
			[TokenScenario.MEDIOCRE]: "mediocre",
			[TokenScenario.STAGNANT]: "stagnant",
			[TokenScenario.BLUE_CHIP]: "bluechip",
			[TokenScenario.PUMP_AND_DUMP]: "pump_dump",
			[TokenScenario.SLOW_BLEED]: "slow_bleed",
		};

		return scenarios.map((s) => mapping[s]);
	}

	private generateTokens(config: SimulationConfig): SimulationToken[] {
		const tokens: SimulationToken[] = [];

		// Default distribution if not provided
		const distribution = config.tokenScenarioDistribution || {
			[TokenScenario.RUG_PULL_FAST]: 0.15,
			[TokenScenario.RUG_PULL_SLOW]: 0.1,
			[TokenScenario.SCAM_TOKEN]: 0.1,
			[TokenScenario.PUMP_AND_DUMP]: 0.15,
			[TokenScenario.MEDIOCRE]: 0.2,
			[TokenScenario.SUCCESSFUL]: 0.15,
			[TokenScenario.RUNNER_MOON]: 0.05,
			[TokenScenario.BLUE_CHIP]: 0.05,
			[TokenScenario.SLOW_BLEED]: 0.05,
		};

		// Generate tokens based on distribution
		for (let i = 0; i < config.tokenCount; i++) {
			const scenario = this.selectScenarioByWeight(distribution);
			const token = this.createToken(scenario, i, config);
			tokens.push(token);
		}

		console.log(
			`📊 Generated ${tokens.length} tokens with scenarios:`,
			tokens.reduce(
				(acc, t) => {
					acc[t.scenario] = (acc[t.scenario] || 0) + 1;
					return acc;
				},
				{} as Record<string, number>,
			),
		);

		return tokens;
	}

	private selectScenarioByWeight(
		distribution: Partial<Record<TokenScenario, number>>,
	): TokenScenario {
		const entries = Object.entries(distribution) as [TokenScenario, number][];
		const totalWeight = entries.reduce((sum, [_, weight]) => sum + weight, 0);
		let random = Math.random() * totalWeight;

		for (const [scenario, weight] of entries) {
			random -= weight;
			if (random <= 0) {
				return scenario;
			}
		}

		return TokenScenario.MEDIOCRE; // Fallback
	}

	private createToken(
		scenario: TokenScenario,
		index: number,
		config: SimulationConfig,
	): SimulationToken {
		// Spread token launches across simulation time
		const launchSpread = config.endTime.getTime() - config.startTime.getTime();
		const launchOffset = Math.random() * launchSpread * 0.8; // Launch in first 80% of simulation

		// Create appropriate scenario from token service
		const scenarioConfig = this.getScenarioConfig(scenario);
		const tokenFromService =
			this.tokenService.createTokenFromScenario(scenarioConfig);

		return {
			address: `0x${uuidv4().replace(/-/g, "")}${index.toString().padStart(8, "0")}`,
			symbol: `SIM${scenario.substring(0, 3).toUpperCase()}${index}`,
			name: `Simulated ${scenario.replace(/_/g, " ")} Token ${index}`,
			scenario,
			launchTime: new Date(config.startTime.getTime() + launchOffset),
			initialPrice: 0.00001 + Math.random() * 0.0001, // $0.00001 - $0.0001
			initialMarketCap: 10000 + Math.random() * 90000, // $10k - $100k
			initialLiquidity: 5000 + Math.random() * 45000, // $5k - $50k
			priceTrajectory: tokenFromService.priceTrajectory,
		};
	}

	private getScenarioConfig(scenario: TokenScenario): TokenScenarioInterface {
		const configs: Record<TokenScenario, TokenScenarioInterface> = {
			[TokenScenario.RUG_PULL_FAST]: {
				type: "rug",
				name: "FastRug Token",
				symbol: "FRUG",
				description: "Rugs within 2 days",
				initialPrice: 0.00001,
				initialLiquidity: 5000,
				initialMarketCap: 10000,
				rugTiming: 2,
			},
			[TokenScenario.RUG_PULL_SLOW]: {
				type: "rug",
				name: "SlowRug Token",
				symbol: "SRUG",
				description: "Builds trust then rugs",
				initialPrice: 0.00005,
				initialLiquidity: 20000,
				initialMarketCap: 50000,
				rugTiming: 10,
			},
			[TokenScenario.SCAM_TOKEN]: {
				type: "scam",
				name: "Scam Token",
				symbol: "SCAM",
				description: "Low liquidity scam",
				initialPrice: 0.001,
				initialLiquidity: 500,
				initialMarketCap: 5000,
			},
			[TokenScenario.RUNNER_MOON]: {
				type: "runner",
				name: "MoonShot Token",
				symbol: "MOON",
				description: "50x growth potential",
				initialPrice: 0.00001,
				initialLiquidity: 50000,
				initialMarketCap: 100000,
			},
			[TokenScenario.RUNNER_STEADY]: {
				type: "runner",
				name: "SteadyGains Token",
				symbol: "GAIN",
				description: "10x steady growth",
				initialPrice: 0.0001,
				initialLiquidity: 30000,
				initialMarketCap: 200000,
			},
			[TokenScenario.SUCCESSFUL]: {
				type: "successful",
				name: "Solid Project",
				symbol: "SOLID",
				description: "3x growth",
				initialPrice: 0.001,
				initialLiquidity: 100000,
				initialMarketCap: 500000,
			},
			[TokenScenario.MEDIOCRE]: {
				type: "mediocre",
				name: "Crabwalk Token",
				symbol: "CRAB",
				description: "Sideways movement",
				initialPrice: 0.01,
				initialLiquidity: 50000,
				initialMarketCap: 300000,
			},
			[TokenScenario.STAGNANT]: {
				type: "stagnant",
				name: "Dead Project",
				symbol: "DEAD",
				description: "No volume",
				initialPrice: 0.005,
				initialLiquidity: 10000,
				initialMarketCap: 50000,
			},
			[TokenScenario.BLUE_CHIP]: {
				type: "bluechip",
				name: "Established Token",
				symbol: "BLUE",
				description: "Stable growth",
				initialPrice: 10.0,
				initialLiquidity: 5000000,
				initialMarketCap: 100000000,
			},
			[TokenScenario.PUMP_AND_DUMP]: {
				type: "pump_dump",
				name: "PumpDump Token",
				symbol: "PUMP",
				description: "20x then dump",
				initialPrice: 0.00001,
				initialLiquidity: 15000,
				initialMarketCap: 20000,
				pumpTiming: 3,
				dumpTiming: 5,
			},
			[TokenScenario.SLOW_BLEED]: {
				type: "slow_bleed",
				name: "BleedOut Token",
				symbol: "BLEED",
				description: "Slow decline",
				initialPrice: 0.01,
				initialLiquidity: 40000,
				initialMarketCap: 200000,
			},
		};

		return configs[scenario];
	}

	private generateCallsForTimeStep(
		currentTime: Date,
		tokens: Map<string, SimulationToken>,
		priceHistory: Map<string, TokenPrice[]>,
		config: SimulationConfig,
	): SimulatedCallData[] {
		const calls: SimulatedCallData[] = [];

		// Get active tokens (launched but not dead)
		const activeTokens = Array.from(tokens.values()).filter((token) => {
			const isLaunched = token.launchTime <= currentTime;
			const history = priceHistory.get(token.address) || [];
			const latestPrice = history[history.length - 1];
			const isDead =
				latestPrice && latestPrice.price < token.initialPrice * 0.01;

			return isLaunched && !isDead;
		});

		if (activeTokens.length === 0) return calls;

		// Each actor makes decisions
		for (const actor of config.actors) {
			// Check if actor should make a call this time step
			const shouldCall = this.shouldActorCall(actor, currentTime);
			if (!shouldCall) continue;

			// Select tokens based on actor preferences
			const targetTokens = this.selectTokensForActor(
				actor,
				activeTokens,
				priceHistory,
				currentTime,
			);

			for (const token of targetTokens) {
				const call = this.generateActorCall(
					actor,
					token,
					priceHistory.get(token.address)!,
					currentTime,
				);

				if (call) {
					calls.push(call);
				}
			}
		}

		return calls;
	}

	private shouldActorCall(actor: ActorConfig, _currentTime: Date): boolean {
		// Base frequency on actor's call frequency setting - increased for better simulation
		const frequencyMultiplier = {
			high: 0.7, // Increased from 0.3
			medium: 0.4, // Increased from 0.1
			low: 0.15, // Increased from 0.03
		}[actor.callFrequency];

		return Math.random() < frequencyMultiplier;
	}

	private selectTokensForActor(
		actor: ActorConfig,
		activeTokens: SimulationToken[],
		priceHistory: Map<string, TokenPrice[]>,
		currentTime: Date,
	): SimulationToken[] {
		// Filter tokens based on actor preferences
		let candidateTokens = activeTokens;

		// Elite analysts and skilled traders should identify good tokens early
		if (["elite_analyst", "skilled_trader"].includes(actor.archetype)) {
			candidateTokens = activeTokens.filter((token) => {
				const _history = priceHistory.get(token.address) || [];
				const timeSinceLaunch =
					(currentTime.getTime() - token.launchTime.getTime()) /
					(1000 * 60 * 60);

				// Focus on quality tokens in early stages
				if (actor.archetype === "elite_analyst") {
					// Elite analysts avoid rugs and scams entirely
					if (
						[
							TokenScenario.RUG_PULL_FAST,
							TokenScenario.RUG_PULL_SLOW,
							TokenScenario.SCAM_TOKEN,
						].includes(token.scenario)
					) {
						return false;
					}
					// Focus on early-stage quality tokens
					return (
						timeSinceLaunch < 48 && // Within 2 days of launch
						[
							TokenScenario.SUCCESSFUL,
							TokenScenario.RUNNER_MOON,
							TokenScenario.RUNNER_STEADY,
							TokenScenario.BLUE_CHIP,
						].includes(token.scenario)
					);
				} else {
					// Skilled traders might catch some pumps but avoid obvious scams
					return (
						timeSinceLaunch < 72 && // Within 3 days
						![TokenScenario.SCAM_TOKEN].includes(token.scenario)
					);
				}
			});
		}

		// FOMO traders chase pumps that have already happened
		else if (actor.archetype === "fomo_trader") {
			candidateTokens = activeTokens.filter((token) => {
				const history = priceHistory.get(token.address) || [];
				if (history.length < 10) return false;

				// Look for tokens that have already pumped significantly
				const recentGain =
					history[history.length - 1].price /
						history[history.length - 10].price -
					1;
				return recentGain > 0.5; // Already up 50%+
			});
		}

		// Pump chasers specifically target pump scenarios
		else if (actor.archetype === "pump_chaser") {
			candidateTokens = activeTokens.filter((token) => {
				const history = priceHistory.get(token.address) || [];
				if (history.length < 5) return false;

				// Look for rapid price increases
				const recentGain =
					history[history.length - 1].price /
						history[history.length - 5].price -
					1;
				return recentGain > 0.3; // Up 30%+ recently
			});
		}

		// Rug promoters target their preferred scam tokens
		else if (actor.archetype === "rug_promoter") {
			candidateTokens = activeTokens.filter(
				(token) =>
					actor.tokenPreferences.includes(token.scenario) &&
					token.scenario !== TokenScenario.BLUE_CHIP, // Even rug promoters avoid obvious blue chips
			);
		}

		// Apply general token preferences if we still have candidates
		if (candidateTokens.length === 0) {
			candidateTokens = activeTokens.filter((token) =>
				actor.tokenPreferences.includes(token.scenario),
			);
		}

		if (candidateTokens.length === 0) return [];

		// Apply timing bias to the candidate tokens
		const timedTokens = candidateTokens.filter((token) => {
			const _history = priceHistory.get(token.address) || [];
			const timeSinceLaunch =
				(currentTime.getTime() - token.launchTime.getTime()) / (1000 * 60 * 60);

			switch (actor.timingBias) {
				case "early":
					return timeSinceLaunch < 24; // First day only
				case "middle":
					return timeSinceLaunch >= 24 && timeSinceLaunch < 120; // Day 1-5
				case "late":
					return timeSinceLaunch >= 72; // After 3 days
				default:
					return true;
			}
		});

		const finalTokens = timedTokens.length > 0 ? timedTokens : candidateTokens;

		// Select 1-2 tokens (elite analysts are more selective)
		const maxTokens = actor.archetype === "elite_analyst" ? 1 : 2;
		const numTokens = Math.min(
			finalTokens.length,
			Math.floor(Math.random() * maxTokens) + 1,
		);

		return finalTokens.sort(() => Math.random() - 0.5).slice(0, numTokens);
	}

	private generateActorCall(
		actor: ActorConfig,
		token: SimulationToken,
		priceHistory: TokenPrice[],
		currentTime: Date,
	): SimulatedCallData | null {
		const latestPrice = priceHistory[priceHistory.length - 1];
		if (!latestPrice) return null;

		// Generate message based on actor archetype
		const message = this.generateMessage(
			actor,
			token.symbol,
			token.scenario,
			"positive", // Will be overridden based on actor logic
		);

		if (!message) return null;

		// Determine sentiment based on actor type and market conditions
		const sentiment = this.determineActorSentiment(actor, token, priceHistory);

		// Determine conviction based on actor confidence
		const conviction = this.determineActorConviction(
			actor,
			token,
			priceHistory,
		);

		return {
			callId: uuidv4() as UUID,
			originalMessageId: `sim_msg_${uuidv4()}`,
			userId: actor.id,
			username: actor.username,
			timestamp: currentTime.getTime(),
			content: message,
			tokenMentioned: token.symbol,
			nameMentioned: token.name,
			caMentioned: token.address,
			chain: SupportedChain.SOLANA,
			sentiment,
			conviction,
			llmReasoning: `${actor.username} (${actor.archetype}) analyzing ${token.symbol}`,
			certainty: "high",
			fileSource: "simulation",
			simulationMetadata: {
				tokenScenario: token.scenario,
				actorArchetype: actor.archetype,
				priceAtCall: latestPrice.price,
				marketCapAtCall: latestPrice.marketCap,
				liquidityAtCall: latestPrice.liquidity,
				expectedOutcome: this.predictOutcome(actor, token),
			},
		};
	}

	private generateMessage(
		actor: ActorConfig,
		tokenSymbol: string,
		_scenario: TokenScenario,
		_sentiment: string,
	): string {
		// Simple message templates based on archetype
		const templates: Record<ActorConfig["archetype"], string[]> = {
			elite_analyst: [
				`$${tokenSymbol} showing strong fundamentals. This is a long-term hold.`,
				`Been researching $${tokenSymbol} - solid team and roadmap. Accumulating here.`,
			],
			skilled_trader: [
				`$${tokenSymbol} looking strong here. Adding to position.`,
				`Good entry point for $${tokenSymbol}. Risk/reward favorable.`,
			],
			pump_chaser: [
				`$${tokenSymbol} is pumping hard! Just aped in!`,
				`Holy shit $${tokenSymbol} is flying! This is going to $1!`,
			],
			rug_promoter: [
				`🚀🚀 $${tokenSymbol} TO THE MOON! 1000X GEM! GET IN NOW! 🚀🚀`,
				`$${tokenSymbol} NEXT 100X!!! DEV DOXXED! LIQUIDITY LOCKED! SAFU! 💎💎`,
			],
			fomo_trader: [
				`Everyone buying $${tokenSymbol}! I'm in!`,
				`$${tokenSymbol} trending everywhere! Don't want to miss this!`,
			],
			contrarian: [
				`$${tokenSymbol} overhyped. Taking opposite position.`,
				`While everyone's bullish on $${tokenSymbol}, I see weakness.`,
			],
			technical_analyst: [
				`$${tokenSymbol} breaking key resistance. Chart looks bullish.`,
				`RSI oversold on $${tokenSymbol}. Bounce incoming.`,
			],
			newbie: [
				`Is $${tokenSymbol} a good buy? Thinking about getting some.`,
				`Just bought my first $${tokenSymbol}! Hope it goes up!`,
			],
			bot_spammer: [
				`💎 $${tokenSymbol} 💎 BUY NOW 💎`,
				`$${tokenSymbol} $${tokenSymbol} $${tokenSymbol} 🚀🚀🚀`,
			],
		};

		const archetypeTemplates = templates[actor.archetype];
		return archetypeTemplates[
			Math.floor(Math.random() * archetypeTemplates.length)
		];
	}

	private determineActorSentiment(
		actor: ActorConfig,
		token: SimulationToken,
		priceHistory: TokenPrice[],
	): "positive" | "negative" | "neutral" {
		// Elite analysts correctly identify token quality
		if (actor.archetype === "elite_analyst") {
			// Positive on good tokens
			if (
				[
					TokenScenario.SUCCESSFUL,
					TokenScenario.RUNNER_MOON,
					TokenScenario.RUNNER_STEADY,
					TokenScenario.BLUE_CHIP,
				].includes(token.scenario)
			) {
				return "positive";
			}
			// Negative on bad tokens (warnings)
			if (
				[
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.RUG_PULL_SLOW,
					TokenScenario.SCAM_TOKEN,
				].includes(token.scenario)
			) {
				return "negative";
			}
			return "neutral";
		}

		// Skilled traders mostly get it right but can be fooled by pump and dumps
		if (actor.archetype === "skilled_trader") {
			if (
				[
					TokenScenario.SUCCESSFUL,
					TokenScenario.RUNNER_MOON,
					TokenScenario.RUNNER_STEADY,
				].includes(token.scenario)
			) {
				return "positive";
			}
			if (
				[TokenScenario.RUG_PULL_FAST, TokenScenario.SCAM_TOKEN].includes(
					token.scenario,
				)
			) {
				return Math.random() < 0.7 ? "negative" : "positive"; // 70% chance to identify scams
			}
			if (token.scenario === TokenScenario.PUMP_AND_DUMP) {
				// Might catch the pump
				const timeSinceLaunch = priceHistory.length;
				return timeSinceLaunch < 5 ? "positive" : "negative";
			}
			return "neutral";
		}

		// Rug promoters always positive on rugs
		if (actor.archetype === "rug_promoter") {
			if (
				[
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.RUG_PULL_SLOW,
					TokenScenario.SCAM_TOKEN,
				].includes(token.scenario)
			) {
				return "positive"; // Shilling scams
			}
			return "neutral";
		}

		// FOMO traders are always positive when chasing
		if (actor.archetype === "fomo_trader") {
			return "positive"; // Always bullish when FOMOing
		}

		// Pump chasers are positive on anything moving up
		if (actor.archetype === "pump_chaser") {
			const priceChange =
				priceHistory.length > 5
					? priceHistory[priceHistory.length - 1].price /
							priceHistory[priceHistory.length - 5].price -
						1
					: 0;
			return priceChange > 0.1 ? "positive" : "neutral";
		}

		// Contrarians go against recent price action
		if (actor.archetype === "contrarian") {
			const priceChange =
				priceHistory.length > 10
					? priceHistory[priceHistory.length - 1].price /
							priceHistory[priceHistory.length - 10].price -
						1
					: 0;
			return priceChange > 0.2 ? "negative" : "positive";
		}

		// Default
		return actor.tokenPreferences.includes(token.scenario)
			? "positive"
			: "neutral";
	}

	private determineActorConviction(
		actor: ActorConfig,
		_token: SimulationToken,
		priceHistory: TokenPrice[],
	): Conviction {
		// Base conviction on actor archetype
		const baseConviction =
			{
				elite_analyst: Conviction.HIGH,
				skilled_trader: Conviction.MEDIUM,
				pump_chaser: Conviction.HIGH,
				rug_promoter: Conviction.VERY_HIGH,
				fomo_trader: Conviction.MEDIUM,
				contrarian: Conviction.MEDIUM,
				technical_analyst: Conviction.MEDIUM,
				newbie: Conviction.LOW,
				bot_spammer: Conviction.LOW,
			}[actor.archetype] || Conviction.MEDIUM;

		// Adjust based on price action for some archetypes
		if (["pump_chaser", "fomo_trader"].includes(actor.archetype)) {
			const recentGain =
				priceHistory.length > 5
					? priceHistory[priceHistory.length - 1].price /
							priceHistory[priceHistory.length - 5].price -
						1
					: 0;

			if (recentGain > 0.5) {
				return Conviction.VERY_HIGH;
			}
		}

		return baseConviction;
	}

	private predictOutcome(
		actor: ActorConfig,
		token: SimulationToken,
	): "profit" | "loss" | "neutral" {
		// Predict based on actor skill and token type
		const successfulScenarios = [
			TokenScenario.SUCCESSFUL,
			TokenScenario.RUNNER_MOON,
			TokenScenario.BLUE_CHIP,
		];

		const isGoodToken = successfulScenarios.includes(token.scenario);
		const isSkilled = [
			"elite_analyst",
			"skilled_trader",
			"contrarian",
		].includes(actor.archetype);

		if (isSkilled && isGoodToken) return "profit";
		if (!isSkilled && !isGoodToken) return "loss";
		if (actor.archetype === "rug_promoter" && !isGoodToken) return "loss";

		return "neutral";
	}

	private calculateActualProfits(
		calls: SimulatedCallData[],
		tokens: Map<string, SimulationToken>,
		priceHistory: Map<string, TokenPrice[]>,
	): Promise<void> {
		for (const call of calls) {
			const token = tokens.get(call.caMentioned || "");
			if (!token) continue;

			const history = priceHistory.get(token.address) || [];
			const callIndex = history.findIndex(
				(p) => p.timestamp.getTime() === call.timestamp,
			);

			if (callIndex === -1 || callIndex === history.length - 1) {
				call.simulationMetadata.actualProfit = 0;
				continue;
			}

			// For negative sentiment calls, calculate profit inversely (profit from price going down)
			if (call.sentiment === "negative") {
				const entryPrice = history[callIndex].price;
				const exitIndex = Math.min(callIndex + 24, history.length - 1);
				const exitPrice = history[exitIndex].price;

				// Profit from warning about bad tokens (short position simulation)
				const priceDropPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
				call.simulationMetadata.actualProfit = priceDropPercent;
				continue;
			}

			// For positive sentiment calls
			let exitIndex: number;
			let forcedExit = false;

			// Check for rug pulls or dumps
			if (
				[
					TokenScenario.RUG_PULL_FAST,
					TokenScenario.RUG_PULL_SLOW,
					TokenScenario.SCAM_TOKEN,
				].includes(token.scenario)
			) {
				// Find when the rug happens
				let rugIndex = callIndex;
				for (let i = callIndex + 1; i < history.length; i++) {
					if (history[i].price < history[callIndex].price * 0.1) {
						// 90% drop = rug
						rugIndex = i;
						forcedExit = true;
						break;
					}
				}
				exitIndex = rugIndex;
			} else if (token.scenario === TokenScenario.PUMP_AND_DUMP) {
				// Find the dump
				let dumpIndex = callIndex;
				let peakPrice = history[callIndex].price;
				for (let i = callIndex + 1; i < history.length; i++) {
					if (history[i].price > peakPrice) {
						peakPrice = history[i].price;
					} else if (history[i].price < peakPrice * 0.3) {
						// 70% drop from peak = dump
						dumpIndex = i;
						forcedExit = true;
						break;
					}
				}
				exitIndex = dumpIndex;
			} else {
				// Normal exit strategies based on actor type
				if (call.simulationMetadata.actorArchetype === "elite_analyst") {
					// Elite analysts hold quality tokens longer
					exitIndex = Math.min(callIndex + 72, history.length - 1); // 3 days
				} else if (
					call.simulationMetadata.actorArchetype === "skilled_trader"
				) {
					// Skilled traders take profits at reasonable times
					exitIndex = Math.min(callIndex + 48, history.length - 1); // 2 days
				} else if (
					["pump_chaser", "fomo_trader"].includes(
						call.simulationMetadata.actorArchetype,
					)
				) {
					// These actors often hold too long and miss the exit
					exitIndex = Math.min(callIndex + 24, history.length - 1); // 1 day
				} else {
					// Default: 24 hour hold
					exitIndex = Math.min(callIndex + 24, history.length - 1);
				}
			}

			const entryPrice = history[callIndex].price;
			const exitPrice = history[exitIndex].price;

			// Apply realistic entry slippage based on actor type
			let effectiveEntryPrice = entryPrice;

			if (
				["fomo_trader", "pump_chaser"].includes(
					call.simulationMetadata.actorArchetype,
				)
			) {
				// FOMO traders buy after the pump, paying premium
				effectiveEntryPrice = entryPrice * 1.15; // 15% slippage
			} else if (call.simulationMetadata.actorArchetype === "rug_promoter") {
				// Rug promoters often buy at terrible prices or don't actually buy
				if (
					[
						TokenScenario.RUG_PULL_FAST,
						TokenScenario.RUG_PULL_SLOW,
						TokenScenario.SCAM_TOKEN,
					].includes(token.scenario)
				) {
					// They're promoting rugs - assume they either don't buy or get rugged
					effectiveEntryPrice = entryPrice * 1.2; // 20% slippage if they buy
				}
			} else if (call.simulationMetadata.actorArchetype === "elite_analyst") {
				// Elite analysts get good entries
				effectiveEntryPrice = entryPrice * 0.98; // 2% better than market
			}

			// Apply exit slippage for forced exits (panic selling)
			let effectiveExitPrice = exitPrice;
			if (
				forcedExit &&
				["pump_chaser", "fomo_trader", "rug_promoter"].includes(
					call.simulationMetadata.actorArchetype,
				)
			) {
				effectiveExitPrice = exitPrice * 0.9; // 10% slippage on panic sell
			}

			const profitPercent =
				((effectiveExitPrice - effectiveEntryPrice) / effectiveEntryPrice) *
				100;

			call.simulationMetadata.actualProfit = profitPercent;
		}

		return Promise.resolve();
	}

	private async cacheResults(
		result: SimulationResult,
		config: SimulationConfig,
	): Promise<void> {
		const outputDir = config.outputDir;
		await fs.mkdir(outputDir, { recursive: true });

		// Save calls
		const callsPath = path.join(outputDir, "simulated_calls.json");
		await fs.writeFile(callsPath, JSON.stringify(result.calls, null, 2));

		// Save tokens
		const tokensPath = path.join(outputDir, "simulated_tokens.json");
		await fs.writeFile(
			tokensPath,
			JSON.stringify(Array.from(result.tokens.entries()), null, 2),
		);

		// Save price history
		const pricesPath = path.join(outputDir, "price_history.json");
		await fs.writeFile(
			pricesPath,
			JSON.stringify(Array.from(result.priceHistory.entries()), null, 2),
		);

		// Save performance summary
		const perfPath = path.join(outputDir, "actor_performance.json");
		await fs.writeFile(
			perfPath,
			JSON.stringify(Array.from(result.actorPerformance.entries()), null, 2),
		);

		console.log(`📁 Results cached to ${outputDir}`);
	}

	async loadCachedSimulation(
		outputDir: string,
	): Promise<SimulationResult | null> {
		try {
			const callsData = await fs.readFile(
				path.join(outputDir, "simulated_calls.json"),
				"utf-8",
			);
			const tokensData = await fs.readFile(
				path.join(outputDir, "simulated_tokens.json"),
				"utf-8",
			);
			const pricesData = await fs.readFile(
				path.join(outputDir, "price_history.json"),
				"utf-8",
			);
			const perfData = await fs.readFile(
				path.join(outputDir, "actor_performance.json"),
				"utf-8",
			);

			return {
				calls: JSON.parse(callsData),
				tokens: new Map(JSON.parse(tokensData)),
				priceHistory: new Map(JSON.parse(pricesData)),
				actorPerformance: new Map(JSON.parse(perfData)),
			};
		} catch (error) {
			console.error("Failed to load cached simulation:", error);
			return null;
		}
	}
}
