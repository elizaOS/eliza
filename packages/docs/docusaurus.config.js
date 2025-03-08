import dotenv from "dotenv";
import { themes as prismThemes } from "prism-react-renderer";

dotenv.config();

// Import the EventEmitter polyfill
require("./src/polyfills/eventEmitter.js");

const config = {
	title: "eliza",
	tagline: "Flexible, scalable AI agents for everyone",
	favicon: "img/favicon.ico",
	url: "https://elizaos.github.io",
	baseUrl: "/eliza/",
	organizationName: "elizaos",
	projectName: "eliza",
	deploymentBranch: "gh-pages",
	trailingSlash: true,
	onBrokenLinks: "ignore",
	onBrokenMarkdownLinks: "warn",
	customFields: {
		// This is a workaround for the EventEmitter issue in the docs build
		EventEmitter: class EventEmitter {
			constructor() {}
			on() {}
			once() {}
			emit() {}
			removeListener() {}
		},
	},
	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},
	markdown: {
		mermaid: true,
	},
	themes: ["@docusaurus/theme-mermaid"],
	clientModules: [require.resolve("./src/polyfills/eventEmitter.js")],
	plugins: [
		[
			"@docusaurus/plugin-content-docs",
			{
				id: "community",
				path: "community",
				routeBasePath: "community",
				sidebarItemsGenerator: async ({
					defaultSidebarItemsGenerator,
					...args
				}) => {
					const sidebarItems = await defaultSidebarItemsGenerator(args);
					return sidebarItems
						.map((item) => {
							if (item.type === "category") {
								switch (item.label.toLowerCase()) {
									case "streams":
										item.label = `📺 ${item.label}`;
										break;
									case "development":
										item.label = `💻 ${item.label}`;
										break;
									case "the_arena":
										item.label = `🏟️ ${item.label}`;
										break;
									default:
										item.label = `📄 ${item.label}`;
								}
							}
							return item;
						})
						.sort((a, b) => {
							const labelA = a.label || ""; // Ensure `label` exists
							const labelB = b.label || ""; // Ensure `label` exists
							return labelA.localeCompare(labelB, undefined, {
								numeric: true,
							});
						});
				},
			},
		],
		[
			"docusaurus-plugin-typedoc",
			{
				entryPoints: ["../core/src/index.ts"],
				tsconfig: "../core/tsconfig.json",
				out: "./api",
				skipErrorChecking: true,
				excludeExternals: false,
				excludePrivate: true,
				excludeProtected: false,
				excludeInternal: false,
				excludeNotDocumented: false,
				plugin: ["typedoc-plugin-markdown"],
				hideGenerator: true,
				cleanOutputDir: true,
				categorizeByGroup: true,
				pretty: true,
				includeVersion: true,
				sort: ["source-order", "required-first", "visibility"],
				gitRevision: "main",
				readme: "none",
				commentStyle: "all",
				preserveAnchorCasing: false,
				externalSymbolLinkMappings: {
					"node:events": {
						EventEmitter:
							"https://nodejs.org/api/events.html#class-eventemitter",
					},
				},
			},
		],
		require.resolve("docusaurus-lunr-search"),
		[
			"@docusaurus/plugin-content-docs",
			{
				id: "api",
				path: "api",
				routeBasePath: "api",
			},
		],
	],
	presets: [
		[
			"classic",
			{
				docs: {
					sidebarPath: "./sidebars.js",
					editUrl: "https://github.com/elizaos/eliza/tree/main/docs/",
					routeBasePath: "docs",
					exclude: ["**/_media/**"],
					showLastUpdateAuthor: true,
					showLastUpdateTime: true,
				},
				theme: {
					customCss: "./src/css/custom.css",
				},
			},
		],
	],
	themeConfig: {
		colorMode: {
			defaultMode: "dark",
			disableSwitch: false,
			respectPrefersColorScheme: true,
		},
		docs: {
			sidebar: {
				hideable: true,
				autoCollapseCategories: true,
			},
		},
		navbar: {
			title: "eliza",
			logo: {
				alt: "Eliza Logo",
				src: "img/favicon.ico",
			},
			items: [
				{
					type: "docSidebar",
					sidebarId: "tutorialSidebar",
					position: "left",
					label: "Documentation",
				},
				{
					type: "doc",
					docsPluginId: "api",
					position: "left",
					label: "API",
					docId: "index",
				},
				{
					type: "doc",
					docsPluginId: "community",
					position: "left",
					label: "Community",
					docId: "index",
				},
				{
					href: "https://github.com/elizaos/eliza",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Docs",
					items: [
						{
							label: "General",
							href: "./",
						},
					],
				},
				{
					title: "Community",
					items: [
						{
							label: "Discord",
							href: "https://discord.gg/ai16z",
						},
						{
							label: "Twitter",
							href: "https://twitter.com/ai16zdao",
						},
					],
				},
				{
					title: "More",
					items: [
						{
							label: "GitHub",
							href: "https://github.com/elizaos/eliza",
						},
					],
				},
			],
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	},
	customFields: {
		GITHUB_ACCESS_TOKEN: process.env.GITHUB_ACCESS_TOKEN,
	},
};

export default config;
