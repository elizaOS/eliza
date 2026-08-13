/**
 * Worker-host fixture module with two valid plugin exports: a metadata-only
 * default export (valid shape, zero actions) and a named `plugin` export that
 * contributes one action. Proves the worker's candidate selection prefers the
 * actions-bearing export instead of letting the actionless default shadow it
 * and trip the zero-action rejection gate.
 */

interface FixtureAction {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: handler args are runtime/message/state/options; fixture only uses content
	handler: (...args: any[]) => unknown | Promise<unknown>;
}

const metadataOnlyDefault: {
	name: string;
	description: string;
} = {
	name: "shadowed-metadata-only",
	description: "Valid plugin shape with no actions; must not win selection",
};

const actionsPlugin: {
	name: string;
	actions: FixtureAction[];
} = {
	name: "shadowed-actions-fixture",
	actions: [
		{
			name: "SHADOWED_ECHO",
			handler: async (
				_runtime: unknown,
				message: { content: unknown },
			) => {
				return { echoed: message.content };
			},
		},
	],
};

export default metadataOnlyDefault;
export { actionsPlugin as plugin };
