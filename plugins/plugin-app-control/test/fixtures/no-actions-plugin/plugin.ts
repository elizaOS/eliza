/**
 * Worker-host fixture plugin that contributes NO actions — only a provider
 * and a route. It is a structurally valid Plugin export, which lets tests
 * prove the worker rejects it explicitly: the sandbox only bridges actions,
 * so booting an actionless plugin would be a healthy-looking no-op.
 */

interface FixtureProvider {
	name: string;
	get: () => Promise<{ text: string; values: Record<string, unknown>; data: Record<string, unknown> }>;
}

interface FixtureRoute {
	name: string;
	path: string;
	type: string;
	handler: (_req: unknown, res: { json: (d: unknown) => void }) => void;
}

const noActionsPlugin: {
	name: string;
	description: string;
	providers: FixtureProvider[];
	routes: FixtureRoute[];
} = {
	name: "no-actions-fixture",
	description: "A valid plugin with providers and routes but no actions",
	providers: [
		{
			name: "GRADIENT_PROVIDER",
			get: async () => ({ text: "gradient", values: {}, data: {} }),
		},
	],
	routes: [
		{
			name: "gradient-route",
			path: "/gradient",
			type: "GET",
			handler: async (_req: unknown, res: { json: (d: unknown) => void }) => {
				res.json({ colors: ["#ff0000", "#00ff00", "#0000ff"] });
			},
		},
	],
};

export default noActionsPlugin;
export { noActionsPlugin };
