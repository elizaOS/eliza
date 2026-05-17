const computerSatellite = {
	id: "eliza.computer",
	name: "Eliza Computer",
	version: "0.1.0",
	description:
		"Computer Satellite for ElizaLaunch. Provides desktop screen, display, and host-context capability operations for Eliza Orbit.",
	mode: "background",
	permissions: {
		bun: {
			read: true,
			write: true,
			run: true,
			env: true,
		},
		isolation: "isolated-process",
	},
	view: {
		relativePath: "src/web/index.html",
		title: "Eliza Computer Satellite",
		width: 480,
		height: 320,
		hidden: true,
	},
	worker: {
		relativePath: "src/bun/worker.ts",
	},
} as const;

export default {
	app: {
		name: "Eliza Computer Satellite",
		identifier: "ai.eliza.launch.computer",
		version: "0.1.0",
	},
	build: {
		carrot: computerSatellite,
		carrotOnly: true,
	},
};
