import {
	DEFAULT_SIGNAL_WEIGHTS,
	type ScoreCardData,
	type ScoreSignal,
} from "./prompt-optimization-trace";

/**
 * In-memory aggregation of `ScoreSignal`s into a weighted `composite` for one trace row.
 *
 * **Why `addAll` calls `add`:** one validation path (truthy signal + numeric `value`) avoids
 * drift between single and batch ingest. **Why `composite` skips NaN:** malformed signals from
 * plugins should not poison the whole score; they are dropped at aggregate time.
 */
export class ScoreCard {
	private _signals: ScoreSignal[] = [];
	private _weightOverrides?: Record<string, number>;

	constructor(weightOverrides?: Record<string, number>) {
		this._weightOverrides = weightOverrides;
	}

	add(signal: ScoreSignal): void {
		if (signal && typeof signal.value === "number") {
			this._signals.push(signal);
		}
	}

	addAll(signals: ScoreSignal[]): void {
		if (!Array.isArray(signals)) return;
		for (const s of signals) this.add(s);
	}

	get signals(): readonly ScoreSignal[] {
		return this._signals as readonly ScoreSignal[];
	}

	bySource(source: string): ScoreSignal[] {
		return this._signals.filter((s) => s.source === source);
	}

	byKind(kind: string): ScoreSignal[] {
		return this._signals.filter((s) => s.kind === kind);
	}

	composite(weightOverrides?: Record<string, number>): number {
		if (this._signals.length === 0) return 0;

		const overrides =
			this._weightOverrides || weightOverrides
				? { ...this._weightOverrides, ...weightOverrides }
				: undefined;

		let weightedSum = 0;
		let totalWeight = 0;

		for (const signal of this._signals) {
			const val = signal.value;
			if (typeof val !== "number" || Number.isNaN(val)) continue;

			const key = `${signal.source}:${signal.kind}`;
			const wildcardKey = `${signal.source}:*`;

			const weight =
				signal.weight ??
				overrides?.[key] ??
				DEFAULT_SIGNAL_WEIGHTS[key] ??
				DEFAULT_SIGNAL_WEIGHTS[wildcardKey] ??
				1.0;

			weightedSum += val * weight;
			totalWeight += weight;
		}

		return totalWeight === 0 ? 0 : weightedSum / totalWeight;
	}

	toJSON(): ScoreCardData {
		return {
			signals: [...this._signals],
			compositeScore: this.composite(),
		};
	}

	static fromJSON(
		data: ScoreCardData,
		weightOverrides?: Record<string, number>,
	): ScoreCard {
		const card = new ScoreCard(weightOverrides);
		if (data && Array.isArray(data.signals)) {
			card.addAll(data.signals);
		}
		return card;
	}
}
