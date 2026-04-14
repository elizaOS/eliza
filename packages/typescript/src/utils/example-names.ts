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
	const offset = Math.floor(Math.random() * EXAMPLE_NAMES.length);
	return (
		EXAMPLE_NAMES[(offset + index) % EXAMPLE_NAMES.length] ?? `user${index + 1}`
	);
}
