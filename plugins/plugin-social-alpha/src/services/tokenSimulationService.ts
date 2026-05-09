import { v4 as uuidv4 } from "uuid";
import { MockPriceService, type SimulatedToken } from "../mockPriceService";
import { SupportedChain } from "../types";

export interface TokenScenario {
	type:
		| "rug"
		| "scam"
		| "runner"
		| "successful"
		| "mediocre"
		| "stagnant"
		| "bluechip"
		| "pump_dump"
		| "slow_bleed";
	name: string;
	symbol: string;
	description: string;
	initialPrice: number;
	initialLiquidity: number;
	initialMarketCap: number;
	rugTiming?: number; // Step when rug happens
	pumpTiming?: number; // Step when pump happens
	dumpTiming?: number; // Step when dump happens
}

export class TokenSimulationService {
	private scenarios: Map<string, TokenScenario> = new Map();

	constructor() {
		this.initializeScenarios();
	}

	private initializeScenarios() {
		// Rug pulls - different timings
		this.addScenario({
			type: "rug",
			name: "FastRug Token",
			symbol: "FRUG",
			description: "Rugs within 2 days of launch",
			initialPrice: 0.00001,
			initialLiquidity: 5000,
			initialMarketCap: 10000,
			rugTiming: 2,
		});

		this.addScenario({
			type: "rug",
			name: "SlowRug Token",
			symbol: "SRUG",
			description: "Builds trust then rugs after 10 days",
			initialPrice: 0.00005,
			initialLiquidity: 20000,
			initialMarketCap: 50000,
			rugTiming: 10,
		});

		// Scams - low liquidity, suspicious patterns
		this.addScenario({
			type: "scam",
			name: "LowLiq Scam",
			symbol: "SCAM",
			description: "Very low liquidity, manipulated price",
			initialPrice: 0.001,
			initialLiquidity: 500, // Very low
			initialMarketCap: 5000,
		});

		// Runners - sustained growth
		this.addScenario({
			type: "runner",
			name: "MoonShot Token",
			symbol: "MOON",
			description: "Legitimate project with 50x growth",
			initialPrice: 0.00001,
			initialLiquidity: 50000,
			initialMarketCap: 100000,
		});

		this.addScenario({
			type: "runner",
			name: "SteadyGains Token",
			symbol: "GAIN",
			description: "Consistent 10x growth over time",
			initialPrice: 0.0001,
			initialLiquidity: 30000,
			initialMarketCap: 200000,
		});

		// Successful but not runners
		this.addScenario({
			type: "successful",
			name: "SolidProject Token",
			symbol: "SOLID",
			description: "Good project with 3x growth",
			initialPrice: 0.001,
			initialLiquidity: 100000,
			initialMarketCap: 500000,
		});

		// Mediocre - sideways movement
		this.addScenario({
			type: "mediocre",
			name: "CrabWalk Token",
			symbol: "CRAB",
			description: "Goes sideways with minor fluctuations",
			initialPrice: 0.01,
			initialLiquidity: 50000,
			initialMarketCap: 300000,
		});

		// Stagnant - no volume, dying
		this.addScenario({
			type: "stagnant",
			name: "DeadProject Token",
			symbol: "DEAD",
			description: "No volume, slowly dying",
			initialPrice: 0.005,
			initialLiquidity: 10000,
			initialMarketCap: 50000,
		});

		// Blue chip - already established
		this.addScenario({
			type: "bluechip",
			name: "Established Token",
			symbol: "BLUE",
			description: "Already successful, stable growth",
			initialPrice: 10.0,
			initialLiquidity: 5000000,
			initialMarketCap: 100000000,
		});

		// Pump and dump
		this.addScenario({
			type: "pump_dump",
			name: "PumpDump Token",
			symbol: "PUMP",
			description: "Pumps 20x then dumps 95%",
			initialPrice: 0.00001,
			initialLiquidity: 15000,
			initialMarketCap: 20000,
			pumpTiming: 3,
			dumpTiming: 5,
		});

		// Slow bleed
		this.addScenario({
			type: "slow_bleed",
			name: "BleedOut Token",
			symbol: "BLEED",
			description: "Slowly loses value over time",
			initialPrice: 0.01,
			initialLiquidity: 40000,
			initialMarketCap: 200000,
		});
	}

	private addScenario(scenario: TokenScenario) {
		this.scenarios.set(scenario.symbol, scenario);
	}

	createTokenFromScenario(scenario: TokenScenario): SimulatedToken {
		const address = `${scenario.symbol}${uuidv4().substring(0, 8)}`;

		let priceTrajectory: (step: number) => number;

		switch (scenario.type) {
			case "rug":
				priceTrajectory = this.createRugTrajectory(scenario);
				break;
			case "scam":
				priceTrajectory = this.createScamTrajectory(scenario);
				break;
			case "runner":
				priceTrajectory = this.createRunnerTrajectory(scenario);
				break;
			case "successful":
				priceTrajectory = this.createSuccessfulTrajectory(scenario);
				break;
			case "mediocre":
				priceTrajectory = this.createMediocreTrajectory(scenario);
				break;
			case "stagnant":
				priceTrajectory = this.createStagnantTrajectory(scenario);
				break;
			case "bluechip":
				priceTrajectory = this.createBluechipTrajectory(scenario);
				break;
			case "pump_dump":
				priceTrajectory = this.createPumpDumpTrajectory(scenario);
				break;
			case "slow_bleed":
				priceTrajectory = this.createSlowBleedTrajectory(scenario);
				break;
			default:
				priceTrajectory = MockPriceService.neutralTokenTrajectory(
					scenario.initialPrice,
				);
		}

		return {
			address,
			symbol: scenario.symbol,
			name: scenario.name,
			chain: SupportedChain.SOLANA,
			performanceType: this.mapScenarioToPerformanceType(scenario.type),
			priceTrajectory,
			initialPrice: scenario.initialPrice,
			liquidity: scenario.initialLiquidity,
			marketCap: scenario.initialMarketCap,
		};
	}

	private mapScenarioToPerformanceType(
		type: TokenScenario["type"],
	): SimulatedToken["performanceType"] {
		switch (type) {
			case "rug":
			case "scam":
			case "pump_dump":
			case "slow_bleed":
				return "bad";
			case "runner":
			case "successful":
			case "bluechip":
				return "good";
			default:
				return "neutral";
		}
	}

	private createRugTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			if (step < scenario.rugTiming!) {
				// Price increases before rug to build trust
				return scenario.initialPrice * 1.5 ** step;
			} else {
				// Rug pull - price drops to near zero
				return scenario.initialPrice * 0.001;
			}
		};
	}

	private createScamTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Highly volatile with overall downward trend
			const volatility = 0.5;
			const trend = -0.1;
			const random = (Math.random() - 0.5) * volatility;
			return scenario.initialPrice * (1 + trend + random) ** step;
		};
	}

	private createRunnerTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Strong upward trend with some consolidation
			const baseGrowth = scenario.symbol === "MOON" ? 0.15 : 0.08;
			const consolidationPeriod = 5;
			const isConsolidating = step % consolidationPeriod < 2;
			const growth = isConsolidating ? 0 : baseGrowth;
			const minorVolatility = (Math.random() - 0.5) * 0.1;
			return scenario.initialPrice * (1 + growth + minorVolatility) ** step;
		};
	}

	private createSuccessfulTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Moderate growth with stability
			const growth = 0.03;
			const volatility = 0.05;
			const random = (Math.random() - 0.5) * volatility;
			return scenario.initialPrice * (1 + growth + random) ** step;
		};
	}

	private createMediocreTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (_step: number) => {
			// Sideways movement
			const volatility = 0.1;
			const random = (Math.random() - 0.5) * volatility;
			return scenario.initialPrice * (1 + random);
		};
	}

	private createStagnantTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Slow death with decreasing volume (reflected in price decline)
			const decay = -0.02;
			const decreasedVolatility = 0.02 * Math.exp(-step * 0.1); // Volatility decreases over time
			const random = (Math.random() - 0.5) * decreasedVolatility;
			return scenario.initialPrice * (1 + decay + random) ** step;
		};
	}

	private createBluechipTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Stable with minor growth
			const growth = 0.01;
			const lowVolatility = 0.03;
			const random = (Math.random() - 0.5) * lowVolatility;
			return scenario.initialPrice * (1 + growth + random) ** step;
		};
	}

	private createPumpDumpTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			if (step < scenario.pumpTiming!) {
				// Normal trading
				return scenario.initialPrice * (1 + (Math.random() - 0.5) * 0.1);
			} else if (step >= scenario.pumpTiming! && step < scenario.dumpTiming!) {
				// Pump phase
				const pumpStep = step - scenario.pumpTiming! + 1;
				return scenario.initialPrice * 5 ** pumpStep;
			} else {
				// Dump phase - lose 95% of peak value
				const peakPrice =
					scenario.initialPrice *
					5 ** (scenario.dumpTiming! - scenario.pumpTiming!);
				return peakPrice * 0.05;
			}
		};
	}

	private createSlowBleedTrajectory(
		scenario: TokenScenario,
	): (step: number) => number {
		return (step: number) => {
			// Consistent decline with false hope rallies
			const baseDecline = -0.03;
			const rallyChance = 0.2;
			const isRally = Math.random() < rallyChance;
			const movement = isRally ? 0.05 : baseDecline;
			const volatility = 0.05;
			const random = (Math.random() - 0.5) * volatility;
			return scenario.initialPrice * (1 + movement + random) ** step;
		};
	}

	getAllScenarios(): TokenScenario[] {
		return Array.from(this.scenarios.values());
	}

	getScenarioBySymbol(symbol: string): TokenScenario | undefined {
		return this.scenarios.get(symbol);
	}

	generateDiverseTokenSet(): SimulatedToken[] {
		const tokens: SimulatedToken[] = [];

		// Generate multiple instances of each scenario type
		for (const scenario of this.scenarios.values()) {
			// Create 1-3 instances of each scenario type
			const instances =
				scenario.type === "bluechip" ? 1 : Math.floor(Math.random() * 3) + 1;

			for (let i = 0; i < instances; i++) {
				const token = this.createTokenFromScenario(scenario);
				// Add some variation to the initial parameters
				if (i > 0) {
					token.initialPrice *= 0.5 + Math.random();
					token.liquidity = token.liquidity
						? token.liquidity * (0.5 + Math.random())
						: undefined;
					token.marketCap = token.marketCap
						? token.marketCap * (0.5 + Math.random())
						: undefined;
				}
				tokens.push(token);
			}
		}

		return tokens;
	}
}
