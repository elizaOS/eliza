/**
 * Fixed roster of gender-neutral placeholder display names for seeding examples
 * and synthetic entities, plus pickRandomExampleName for a random pick (with a
 * `user<n>` fallback). The ordered `as const` list keeps seeded consumers
 * (deterministic.ts) reproducible across runs.
 */

export const EXAMPLE_NAMES = [
	"Avery",
	"Blake",
	"Casey",
	"Cleo",
	"Drew",
	"Emery",
	"Finley",
	"Harper",
	"Indigo",
	"Jules",
	"Kai",
	"Lane",
	"Logan",
	"Morgan",
	"Nova",
	"Parker",
	"Quinn",
	"Reese",
	"River",
	"Rowan",
	"Sage",
	"Skyler",
	"Taylor",
	"Wren",
] as const;

export function pickRandomExampleName(index = 0): string {
	const safeIndex =
		typeof index === "number" && Number.isFinite(index) ? Math.floor(index) : 0;
	const offset = Math.floor(Math.random() * EXAMPLE_NAMES.length);
	const normalizedOffset =
		(((offset + safeIndex) % EXAMPLE_NAMES.length) + EXAMPLE_NAMES.length) %
		EXAMPLE_NAMES.length;
	return EXAMPLE_NAMES[normalizedOffset] ?? `user${safeIndex + 1}`;
}
