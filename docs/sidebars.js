/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
    tutorialSidebar: [
        {
            type: "doc",
            id: "intro",
            label: "🚀 Introduction",
        },
        {
            type: "category",
            label: "🏁 Getting Started",
            items: [
                {
                    type: "doc",
                    id: "quickstart",
                    label: "⭐ Quick Start",
                },
                {
                    type: "doc",
                    id: "faq",
                    label: "❓ FAQ",
                },
				{
					type: "category",
					label: "Tutorials",
                    items: [
                        {
                            type: "category",
                            label: "AI Agent Dev School",
                            items: [
                                {
                                    type: "doc",
                                    id: "tutorials/index",
                                    label: "Overview",
                                },                            
                                {
                                    type: "doc",
                                    id: "tutorials/part1",
                                    label: "Part 1",
                                },
                                {
                                    type: "doc",
                                    id: "tutorials/part2",
                                    label: "Part 2",
                                },
                                {
                                    type: "doc",
                                    id: "tutorials/part3",
                                    label: "Part 3",
                                },
                            ],
                            collapsed: true, // Expand by default
                        },
                        {
                            type: "doc",
                            id: "tutorials/nader_tutorial_10min",
                            label: "Clone Yourself in 10min",
                        },
                        {
                            type: "doc",
                            id: "tutorials/nader_tutorial_15min",
                            label: "Build Social Agents in 15min",
                        },                        
                        {
                            type: "doc",
                            id: "tutorials/nader_tutorial_35min",
                            label: "Build a Plugin in 35min",
                        },                        
                    ],
                    collapsed: true, // Expand by default
                },
			],
            collapsed: false,
        },
        {
            type: "category",
            label: "🧠 Core Concepts",
            collapsed: false,
            items: [
                {
                    type: "doc",
                    id: "core/characterfile",
                    label: "Character Files",
                },
                {
                    type: "doc",
                    id: "core/agents",
                    label: "Agents",
                },
                {
                    type: "doc",
                    id: "core/providers",
                    label: "Providers",
                },
                {
                    type: "doc",
                    id: "core/actions",
                    label: "Actions",
                },
                {
                    type: "doc",
                    id: "core/evaluators",
                    label: "Evaluators",
                },
            ],
        },
        {
            type: "category",
            label: "📘 Guides",
            collapsed: false,
            items: [
                {
                    type: "doc",
                    id: "guides/configuration",
                    label: "Configuration",
                },
                {
                    type: "doc",
                    id: "guides/fine-tuning",
                    label: "Fine-tuning",
                },
                {
                    type: "doc",
                    id: "guides/advanced",
                    label: "Advanced Usage",
                },
                {
                    type: "doc",
                    id: "guides/secrets-management",
                    label: "Secrets Management",
                },
                {
                    type: "doc",
                    id: "guides/memory-management",
                    label: "Memory Management",
                },
                {
                    type: "doc",
                    id: "guides/local-development",
                    label: "Local Development",
                },
                {
                    type: "doc",
                    id: "guides/wsl",
                    label: "WSL Setup",
                },
            ],
        },
        {
            type: "category",
            label: "🎓 Advanced Topics",
            collapsed: false,
            items: [
                {
                    type: "doc",
                    id: "advanced/infrastructure",
                    label: "Infrastructure",
                },
                {
                    type: "doc",
                    id: "advanced/trust-engine",
                    label: "Trust Engine",
                },
                {
                    type: "doc",
                    id: "advanced/autonomous-trading",
                    label: "Autonomous Trading",
                },
                {
                    type: "doc",
                    id: "advanced/eliza-in-tee",
                    label: "Eliza in TEE",
                },
                {
                    type: "doc",
                    id: "advanced/verified-inference",
                    label: "Verified Inference",
                },
            ],
        },
        {
            type: "category",
            label: "📦 Packages",
            collapsed: false,
            items: [
                {
                    type: "doc",
                    id: "packages/packages",
                    label: "Overview",
                },
                {
                    type: "doc",
                    id: "packages/core",
                    label: "Core Package",
                },
                {
                    type: "doc",
                    id: "packages/adapters",
                    label: "Database Adapters",
                },
                {
                    type: "doc",
                    id: "packages/clients",
                    label: "Client Packages",
                },
                {
                    type: "doc",
                    id: "packages/agent",
                    label: "Agent Package",
                },
                {
                    type: "doc",
                    id: "packages/plugins",
                    label: "Plugin System",
                },
            ],
        },
    ],
};

export default sidebars;
