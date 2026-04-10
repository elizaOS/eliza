import type { ScoreCardData, ScoreSignal } from "./types.ts";
import { DEFAULT_SIGNAL_WEIGHTS } from "./types.ts";

/**
 * ScoreCard accumulates weighted signals from multiple sources and computes
 * a single composite score.
 *
 * WHY a class with mutable state: signals arrive at different times during a
 * request lifecycle — DPE adds structural signals immediately, evaluators add
 * quality signals later, plugin-neuro adds user feedback even later. The same
 * ScoreCard instance accumulates all of them, and the composite is recomputed
 * on demand (not cached) so it always reflects the latest signals.
 *
 * WHY weighted average (not sum): different signal types have fundamentally
 * different scales and importance. A weighted average normalizes contributions
 * so adding a new signal source doesn't distort existing scores.
 */
export class ScoreCard {
	private _signals: ScoreSignal[] = [];
	/** Optional weight overrides applied when computing the composite score in toJSON(). */
	private _weightOverrides?: Record<string, number>;

	constructor(weightOverrides?: Record<string, number>) {
		this._weightOverrides = weightOverrides;
	}

	add(signal: ScoreSignal): void {
		this._signals.push(signal);
	}

	addAll(signals: ScoreSignal[]): void {
		if (!Array.isArray(signals)) return;
		for (const signal of signals) {
			if (signal && typeof signal.value === "number") {
				this._signals.push(signal);
			}
		}
	}

	/** Read-only snapshot of accumulated signals. */
	get signals(): readonly ScoreSignal[] {
		return this._signals as readonly ScoreSignal[];
	}

	bySource(source: string): ScoreSignal[] {
		return this._signals.filter((s) => s.source === source);
	}

	byKind(kind: string): ScoreSignal[] {
		return this._signals.filter((s) => s.kind === kind);
	}

	/**
	 * Compute weighted average of all signals.
	 *
	 * Weight lookup order:
	 * 1. Signal's own `weight` field
	 * 2. weightOverrides[`${source}:${kind}`]
	 * 3. DEFAULT_SIGNAL_WEIGHTS[`${source}:${kind}`]
	 * 4. DEFAULT_SIGNAL_WEIGHTS[`${source}:*`] (wildcard)
	 * 5. 1.0 (default)
	 */
	composite(weightOverrides?: Record<string, number>): number {
		if (this._signals.length === 0) return 0;

		// Merge instance-level overrides with call-level overrides (call wins).
		// Passing {} no longer drops constructor defaults.
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

	/** Restore a ScoreCard from its serialized form */
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
