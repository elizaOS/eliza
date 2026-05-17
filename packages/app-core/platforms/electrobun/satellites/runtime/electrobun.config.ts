const runtimeSatellite = {
	id: "eliza.runtime",
	name: "Eliza Runtime",
	description: "Runtime Satellite that supervises the local elizaOS runtime.",
	mode: "background",
	carrotOnly: true,
	permissions: {
		host: {
			storage: true,
		},
		bun: {
			read: true,
			write: true,
			env: true,
			run: true,
			worker: true,
		},
		isolation: "isolated-process",
	},
	view: {
		relativePath: "src/web/index.html",
		title: "Eliza Runtime Satellite",
		width: 720,
		height: 520,
	},
	worker: {
		relativePath: "src/bun/worker.ts",
	},
} as const;

export default {
	app: {
		name: "Eliza Runtime Satellite",
		identifier: "ai.eliza.launch.runtime",
		version: "0.1.0",
		description: "Runtime Satellite for ElizaLaunch.",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		bun: {
			entrypoint: "src/bun/worker.ts",
		},
		views: {},
		carrot: runtimeSatellite,
	},
};
