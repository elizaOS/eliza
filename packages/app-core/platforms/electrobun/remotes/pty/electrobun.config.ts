const terminalRemote = {
	id: "eliza.pty",
	name: "Eliza Terminal",
	version: "0.1.0",
	description:
		"Terminal Remote for ElizaLaunch. Provides trusted local terminal sessions for Eliza Orbit.",
	mode: "background",
	permissions: {
		host: {
			storage: true,
			notifications: true,
			"manage-carrots": true,
		},
		bun: {
			read: true,
			write: true,
			env: true,
			run: true,
			worker: true,
			ffi: true,
			addons: true,
		},
		isolation: "isolated-process",
	},
	view: {
		relativePath: "src/web/index.html",
		title: "Eliza Terminal Remote",
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
		name: "Eliza Terminal Remote",
		identifier: "ai.eliza.launch.pty",
		version: "0.1.0",
	},
	build: {
		carrot: terminalRemote,
		carrotOnly: true,
	},
};
