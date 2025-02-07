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
                    id: "advanced/fine-tuning",
                    label: "Fine-tuning",
                },
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
