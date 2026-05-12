# elizaOS Documentation

Welcome to the official documentation repository for [elizaOS](https://github.com/elizaos/eliza) - a powerful framework for building AI agents with memory, planning, and tool use capabilities.

## 📚 About This Documentation

This repository contains the comprehensive documentation for elizaOS, including:

- **Getting Started** - Quick setup guides and tutorials
- **Core Concepts** - Understanding agents, plugins, and the architecture
- **Deep Dive** - Advanced topics like memory systems, services, and event handling
- **REST Reference** - Complete REST API documentation for all modules
- **Examples** - Real-world implementations and patterns

## Development

### Prerequisites

- Node.js (v23 or higher)
- bun (or npm/yarn)

### Local Development Setup

Install the [Mintlify CLI](https://www.npmjs.com/package/mint) to preview the documentation changes locally:

```bash
bun install -g mint
```

### Running Locally

This package is the canonical doc root. From the repository root:

```bash
cd packages/docs && mint dev
```

This starts a local preview (default `http://localhost:3000`). The repository root also has a `docs` symlink → `packages/docs` so existing `docs/...` paths keep resolving.

### Project structure

```
packages/docs/
├── docs.json              # Mintlify configuration
├── rest-reference/        # REST API reference (Mintlify pages)
├── rest/                  # Product REST guides (markdown)
├── guides/, plugins/, …   # Guides and reference content
├── images/, logo/
├── index.mdx
└── quickstart.mdx
```

## 📝 Contributing to Documentation

We welcome contributions to improve the elizaOS documentation! Here's how you can help:

1. **Fork** this repository
2. **Create** a new branch for your changes
3. **Make** your documentation improvements
4. **Test** locally using `mint dev`
5. **Submit** a pull request

### Documentation Guidelines

- Use clear, concise language
- Include code examples where appropriate
- Follow the existing structure and formatting
- Test all code snippets
- Add images/diagrams for complex concepts

## Publishing Changes

Changes are automatically deployed when merged to the main branch. The documentation is hosted using Mintlify's infrastructure.

### Deployment Process

1. Install the Mintlify GitHub App on your repository
2. Push changes to your default branch
3. Changes will be automatically deployed to production

Find the installation link in your [Mintlify dashboard](https://dashboard.mintlify.com).

## 🔧 Troubleshooting

### Common Issues

- **Dev environment not running**
  - Run `mint update` to ensure you have the latest version of the CLI
  - Check that you're in the correct directory with `docs.json`

- **Page loads as 404**
  - Ensure you're running the command in a folder containing `docs.json`
  - Check that your page is properly listed in the navigation

- **Changes not reflecting**
  - Clear your browser cache
  - Restart the development server
  - Check for syntax errors in your MDX files

## 📖 Learn More

- [elizaOS GitHub Repository](https://github.com/elizaos/elizaos)
- [Mintlify Documentation](https://mintlify.com/docs)
- [MDX Documentation](https://mdxjs.com/)

## 📄 License

This documentation is part of the elizaOS project. Please refer to the main repository for license information.

---

Built with ❤️ using [Mintlify](https://mintlify.com)
