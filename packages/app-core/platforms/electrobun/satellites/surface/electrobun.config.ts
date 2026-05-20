const surfaceSatellite = {
	id: "eliza.surface",
	name: "Eliza Surface",
	version: "0.1.0",
	description:
		"Surface Satellite for ElizaLaunch. Provides a control and chat UI backed by eliza.runtime.",
	mode: "window",
	permissions: {
		host: {
			"manage-carrots": true,
		},
		bun: {},
		isolation: "shared-worker",
	},
	view: {
		relativePath: "src/web/index.html",
		title: "Eliza Surface Satellite",
		width: 1280,
		height: 860,
		titleBarStyle: "hiddenInset",
		transparent: false,
	},
	worker: {
		relativePath: "src/bun/worker.ts",
	},
} as const;

export default {
	app: {
		name: "Eliza Surface Satellite",
		identifier: "ai.eliza.launch.surface",
		version: "0.1.0",
	},
	build: {
		carrot: surfaceSatellite,
		carrotOnly: true,
	},
};
