import type { SupportedChain } from "./types";

export interface SimulatedToken {
	address: string;
	symbol: string;
	name: string;
	chain: SupportedChain;
	initialPrice: number;
	performanceType?: "good" | "bad" | "neutral";
	priceTrajectory?: (step: number) => number;
	currentPrice?: number;
	liquidity?: number;
	marketCap?: number;
	createdAt?: number;
}

export class MockPriceService {
	private tokens = new Map<string, SimulatedToken>();

	static neutralTokenTrajectory(
		initialPrice: number,
	): (step: number) => number {
		return (step: number) => initialPrice * (1 + Math.sin(step / 10) * 0.02);
	}

	addToken(token: SimulatedToken): void {
		this.tokens.set(token.address, token);
		this.tokens.set(token.symbol.toUpperCase(), token);
	}

	getToken(addressOrSymbol: string): SimulatedToken | undefined {
		return (
			this.tokens.get(addressOrSymbol) ??
			this.tokens.get(addressOrSymbol.toUpperCase())
		);
	}

	getPrice(addressOrSymbol: string): number | null {
		const token = this.getToken(addressOrSymbol);
		return token?.currentPrice ?? token?.initialPrice ?? null;
	}
}
