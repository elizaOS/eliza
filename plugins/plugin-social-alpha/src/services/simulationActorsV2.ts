import type { UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { SimulatedToken } from "../mockPriceService";
import { Conviction, type SupportedChain } from "../types";
import type { TokenScenario } from "./tokenSimulationService";

export interface SimulatedCallV2 {
	callId: string;
	userId: string;
	username: string;
	timestamp: number;
	tokenMentioned: string;
	tokenAddress: string;
	sentiment: "positive" | "negative" | "neutral";
	conviction: Conviction;
	content: string;
	chain: SupportedChain;
	certainty: "high" | "medium" | "low";
	llmReasoning: string;
}

export type ActorArchetypeV2 =
	| "elite_analyst" // Makes excellent calls on good projects early
	| "skilled_trader" // Good calls but not perfect
	| "pump_chaser" // Buys tops, gets rugged
	| "rug_promoter" // Shills rugs and scams
	| "fomo_trader" // Always late to the party
	| "contrarian" // Goes against the crowd
	| "whale_watcher" // Follows big money (sometimes good, sometimes bad)
	| "technical_analyst" // Uses TA, mixed results
	| "newbie" // Random, learning
	| "bot_spammer"; // High volume, low quality

export interface SimulatedActorV2 {
	id: UUID;
	username: string;
	archetype: ActorArchetypeV2;
	trustScore?: number; // Expected trust score for validation
	callHistory: SimulatedCallV2[];
	preferences: {
		favoriteTokenTypes?: TokenScenario["type"][];
		callFrequency: "high" | "medium" | "low";
		timingBias: "early" | "middle" | "late" | "random";
	};
}

export class SimulationActorsServiceV2 {
	private actors: Map<UUID, SimulatedActorV2> = new Map();

	constructor() {
		this.initializeActors();
	}

	private initializeActors() {
		// Elite Analyst - Should have highest trust score
		this.addActor({
			id: uuidv4() as UUID,
			username: "CryptoSage",
			archetype: "elite_analyst",
			trustScore: 95, // Expected
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["runner", "successful", "bluechip"],
				callFrequency: "medium",
				timingBias: "early",
			},
		});

		// Skilled Trader
		this.addActor({
			id: uuidv4() as UUID,
			username: "ProfitHunter",
			archetype: "skilled_trader",
			trustScore: 75,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["runner", "successful", "pump_dump"], // Sometimes catches pumps
				callFrequency: "medium",
				timingBias: "early",
			},
		});

		// Pump Chaser - Should have low trust score
		this.addActor({
			id: uuidv4() as UUID,
			username: "MoonBoy2024",
			archetype: "pump_chaser",
			trustScore: 25,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["pump_dump", "rug", "scam"],
				callFrequency: "high",
				timingBias: "late",
			},
		});

		// Rug Promoter - Should have very low trust score
		this.addActor({
			id: uuidv4() as UUID,
			username: "100xGems",
			archetype: "rug_promoter",
			trustScore: 10,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["rug", "scam"],
				callFrequency: "high",
				timingBias: "early", // Shills early to dump on followers
			},
		});

		// FOMO Trader
		this.addActor({
			id: uuidv4() as UUID,
			username: "AlwaysLate",
			archetype: "fomo_trader",
			trustScore: 30,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["runner", "pump_dump"], // Sees movement, jumps in
				callFrequency: "high",
				timingBias: "late",
			},
		});

		// Contrarian
		this.addActor({
			id: uuidv4() as UUID,
			username: "AgainstGrain",
			archetype: "contrarian",
			trustScore: 60, // Mixed results
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["mediocre", "stagnant", "slow_bleed"],
				callFrequency: "medium",
				timingBias: "random",
			},
		});

		// Technical Analyst
		this.addActor({
			id: uuidv4() as UUID,
			username: "ChartMaster",
			archetype: "technical_analyst",
			trustScore: 65,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["bluechip", "successful", "runner"],
				callFrequency: "low",
				timingBias: "middle",
			},
		});

		// Newbie
		this.addActor({
			id: uuidv4() as UUID,
			username: "CryptoNoob",
			archetype: "newbie",
			trustScore: 40,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: [], // Random
				callFrequency: "medium",
				timingBias: "random",
			},
		});

		// Bot Spammer
		this.addActor({
			id: uuidv4() as UUID,
			username: "SignalsBot",
			archetype: "bot_spammer",
			trustScore: 15,
			callHistory: [],
			preferences: {
				favoriteTokenTypes: ["scam", "rug", "pump_dump"],
				callFrequency: "high",
				timingBias: "random",
			},
		});
	}

	private addActor(actor: SimulatedActorV2) {
		this.actors.set(actor.id, actor);
	}

	generateCallsForActor(
		actor: SimulatedActorV2,
		token: SimulatedToken,
		tokenScenario: TokenScenario,
		currentStep: number,
		priceHistory: { step: number; price: number }[],
	): SimulatedCallV2 | null {
		// Determine if actor should make a call based on their strategy
		if (
			!this.shouldMakeCall(
				actor,
				token,
				tokenScenario,
				currentStep,
				priceHistory,
			)
		) {
			return null;
		}

		const sentiment = this.determineSentiment(
			actor,
			token,
			tokenScenario,
			currentStep,
			priceHistory,
		);
		const conviction = this.determineConviction(
			actor,
			token,
			tokenScenario,
			currentStep,
			priceHistory,
		);
		const content = this.generateCallContent(
			actor,
			token,
			sentiment,
			conviction,
			priceHistory,
		);

		const call: SimulatedCallV2 = {
			callId: uuidv4(),
			userId: actor.id,
			username: actor.username,
			timestamp: Date.now() + currentStep * 24 * 60 * 60 * 1000, // Add days to current time
			tokenMentioned: token.symbol,
			tokenAddress: token.address,
			sentiment,
			conviction,
			content,
			chain: token.chain,
			certainty: this.determineCertainty(actor, tokenScenario),
			llmReasoning: this.generateReasoning(actor, token, sentiment, conviction),
		};

		actor.callHistory.push(call);
		return call;
	}

	private shouldMakeCall(
		actor: SimulatedActorV2,
		_token: SimulatedToken,
		_tokenScenario: TokenScenario,
		currentStep: number,
		_priceHistory: { step: number; price: number }[],
	): boolean {
		// Call frequency check - use probability not reverse threshold
		const frequencyThreshold = {
			high: 0.7,
			medium: 0.4,
			low: 0.2,
		};

		// Fixed: should be less than, not greater than
		if (Math.random() > frequencyThreshold[actor.preferences.callFrequency]) {
			return false;
		}

		// Check timing preference
		const totalSteps = 30; // Assume 30-day simulation
		const phase = currentStep / totalSteps;

		switch (actor.preferences.timingBias) {
			case "early":
				return phase < 0.4 || (phase < 0.6 && Math.random() < 0.5);
			case "middle":
				return phase >= 0.2 && phase <= 0.8;
			case "late":
				return phase > 0.6 || (phase > 0.4 && Math.random() < 0.5);
			case "random":
				return true;
		}

		return true;
	}

	private determineSentiment(
		actor: SimulatedActorV2,
		_token: SimulatedToken,
		tokenScenario: TokenScenario,
		_currentStep: number,
		priceHistory: { step: number; price: number }[],
	): "positive" | "negative" | "neutral" {
		switch (actor.archetype) {
			case "elite_analyst":
				// Correctly identifies good projects as positive, bad as negative
				if (["runner", "successful", "bluechip"].includes(tokenScenario.type)) {
					return "positive";
				} else if (
					["rug", "scam", "pump_dump", "slow_bleed"].includes(
						tokenScenario.type,
					)
				) {
					return "negative";
				}
				return "neutral";

			case "rug_promoter":
				// Always positive on rugs and scams
				if (["rug", "scam"].includes(tokenScenario.type)) {
					return "positive";
				}
				return "neutral";

			case "pump_chaser":
				// Positive when price is rising
				if (priceHistory.length > 1) {
					const recentPrice = priceHistory[priceHistory.length - 1].price;
					const previousPrice = priceHistory[priceHistory.length - 2].price;
					return recentPrice > previousPrice ? "positive" : "negative";
				}
				return "positive";

			case "contrarian":
				// Opposite of recent price movement
				if (priceHistory.length > 2) {
					const recentTrend =
						priceHistory[priceHistory.length - 1].price -
						priceHistory[priceHistory.length - 3].price;
					return recentTrend > 0 ? "negative" : "positive";
				}
				return "neutral";

			default: {
				// Random for others
				const rand = Math.random();
				if (rand < 0.5) return "positive";
				if (rand < 0.8) return "negative";
				return "neutral";
			}
		}
	}

	private determineConviction(
		actor: SimulatedActorV2,
		_token: SimulatedToken,
		tokenScenario: TokenScenario,
		_currentStep: number,
		priceHistory: { step: number; price: number }[],
	): Conviction {
		switch (actor.archetype) {
			case "elite_analyst":
				// High conviction on clear winners/losers
				if (["runner", "rug", "scam"].includes(tokenScenario.type)) {
					return Conviction.HIGH;
				}
				return Conviction.MEDIUM;

			case "rug_promoter":
			case "bot_spammer":
				// Always high conviction (to seem convincing)
				return Conviction.HIGH;

			case "newbie":
				// Usually low conviction
				return Math.random() < 0.8 ? Conviction.LOW : Conviction.MEDIUM;

			case "technical_analyst":
				// Conviction based on "technical signals"
				if (priceHistory.length > 5) {
					// Fake TA: check if breaking "resistance"
					const recent = priceHistory.slice(-5);
					const highestRecent = Math.max(...recent.map((p) => p.price));
					if (
						priceHistory[priceHistory.length - 1].price >
						highestRecent * 0.95
					) {
						return Conviction.HIGH;
					}
				}
				return Conviction.MEDIUM;

			default: {
				const rand = Math.random();
				if (rand < 0.3) return Conviction.HIGH;
				if (rand < 0.7) return Conviction.MEDIUM;
				return Conviction.LOW;
			}
		}
	}

	private generateCallContent(
		actor: SimulatedActorV2,
		token: SimulatedToken,
		sentiment: "positive" | "negative" | "neutral",
		_conviction: Conviction,
		priceHistory: { step: number; price: number }[],
	): string {
		const templates: Record<
			string,
			{ positive: string[]; negative: string[]; neutral?: string[] }
		> = {
			elite_analyst: {
				positive: [
					`$${token.symbol} showing strong fundamentals. This is a long-term hold.`,
					`Been researching $${token.symbol} - solid team and roadmap. Accumulating here.`,
					`$${token.symbol} is undervalued at current levels. Target: ${(priceHistory[priceHistory.length - 1].price * 5).toFixed(6)}`,
				],
				negative: [
					`Warning: $${token.symbol} showing red flags. Low liquidity, suspicious wallet activity.`,
					`Avoid $${token.symbol} - classic rug setup. Dev wallets hold 40%+`,
					`$${token.symbol} is a clear scam. Don't fall for it.`,
				],
				neutral: [
					`Watching $${token.symbol} closely. Need more data before making a call.`,
					`$${token.symbol} on my radar. Waiting for better entry.`,
				],
			},
			rug_promoter: {
				positive: [
					`🚀🚀 $${token.symbol} TO THE MOON! 1000X GEM! GET IN NOW! 🚀🚀`,
					`$${token.symbol} NEXT 100X!!! DEV DOXXED! LIQUIDITY LOCKED! SAFU! 💎💎`,
					`BREAKING: $${token.symbol} ABOUT TO EXPLODE! WHALES ACCUMULATING! 🐋`,
				],
				negative: [],
				neutral: [],
			},
			pump_chaser: {
				positive: [
					`$${token.symbol} is pumping hard! Just aped in!`,
					`Holy shit $${token.symbol} is flying! This is going to $1!`,
					`Everyone talking about $${token.symbol}! Don't miss out!`,
				],
				negative: [
					`Fuck, $${token.symbol} dumping. Should have sold earlier.`,
					`$${token.symbol} rugged. Lost everything. Stay away.`,
				],
				neutral: [],
			},
			technical_analyst: {
				positive: [
					`$${token.symbol} breaking key resistance at ${priceHistory[priceHistory.length - 1].price.toFixed(6)}. Next target: ${(priceHistory[priceHistory.length - 1].price * 1.5).toFixed(6)}`,
					`Bullish divergence on $${token.symbol} 4H chart. Accumulation zone.`,
					`$${token.symbol} forming cup and handle. Breakout imminent.`,
				],
				negative: [
					`$${token.symbol} lost critical support. Expecting further downside.`,
					`Death cross forming on $${token.symbol}. Time to exit.`,
				],
				neutral: [
					`$${token.symbol} consolidating. Waiting for breakout direction.`,
					`$${token.symbol} at key level. Could go either way.`,
				],
			},
		};

		const defaultTemplates = {
			positive: [`I think $${token.symbol} looks good`],
			negative: [`$${token.symbol} doesn't look great`],
			neutral: [`Watching $${token.symbol}`],
		};

		const archetypeTemplates = templates[actor.archetype] || defaultTemplates;
		const sentimentTemplates = archetypeTemplates[sentiment] ||
			archetypeTemplates.positive ||
			defaultTemplates[sentiment] || [`Watching $${token.symbol}`];

		return (
			sentimentTemplates[
				Math.floor(Math.random() * sentimentTemplates.length)
			] || `Looking at $${token.symbol}`
		);
	}

	private determineCertainty(
		actor: SimulatedActorV2,
		_tokenScenario: TokenScenario,
	): "high" | "medium" | "low" {
		switch (actor.archetype) {
			case "elite_analyst":
				return "high";
			case "skilled_trader":
			case "technical_analyst":
				return "medium";
			case "newbie":
			case "pump_chaser":
				return "low";
			default:
				return "medium";
		}
	}

	private generateReasoning(
		actor: SimulatedActorV2,
		token: SimulatedToken,
		sentiment: "positive" | "negative" | "neutral",
		conviction: Conviction,
	): string {
		return `${actor.username} (${actor.archetype}) made a ${conviction} conviction ${sentiment} call on ${token.symbol}`;
	}

	getAllActors(): SimulatedActorV2[] {
		return Array.from(this.actors.values());
	}

	getActorById(id: UUID): SimulatedActorV2 | undefined {
		return this.actors.get(id);
	}

	getExpectedRankings(): { username: string; expectedTrustScore: number }[] {
		return Array.from(this.actors.values())
			.map((actor) => ({
				username: actor.username,
				expectedTrustScore: actor.trustScore || 50,
			}))
			.sort((a, b) => b.expectedTrustScore - a.expectedTrustScore);
	}
}
