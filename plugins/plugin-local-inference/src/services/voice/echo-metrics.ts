/**
 * Echo-return-loss-enhancement in dB: 10*log10(sum(near^2) / sum(residual^2)).
 * Higher is better. Returns +Infinity when the residual is silent and 0 when
 * there is no near-end energy to enhance.
 */
export function computeErle(
	nearEnd: Float32Array,
	residual: Float32Array,
): number {
	let nearEnergy = 0;
	let residualEnergy = 0;
	const len = Math.min(nearEnd.length, residual.length);
	for (let i = 0; i < len; i++) {
		nearEnergy += nearEnd[i] * nearEnd[i];
		residualEnergy += residual[i] * residual[i];
	}
	if (nearEnergy === 0) return 0;
	if (residualEnergy === 0) return Number.POSITIVE_INFINITY;
	return 10 * Math.log10(nearEnergy / residualEnergy);
}
