const gitSatellite = {
	id: "eliza.git",
	name: "Eliza Git",
	version: "0.1.0",
	description:
		"Git Satellite for ElizaLaunch. Provides trusted local Git operations for Eliza Orbit.",
	mode: "background",
	permissions: {
		host: {
			storage: true,
			"manage-carrots": true,
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
		title: "Eliza Git Satellite",
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
		name: "Eliza Git Satellite",
		identifier: "ai.eliza.launch.git",
		version: "0.1.0",
	},
	build: {
		carrot: gitSatellite,
		carrotOnly: true,
	},
};
