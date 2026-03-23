# Contributing to elizaOS

First off, thank you for considering contributing to elizaOS! 🎉 It's people like you that make elizaOS such a great framework.

## Code of Conduct

This project and everyone participating in it is governed by our commitment to:
- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions

## How Can I Contribute?

### Reporting Bugs 🐛

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (code snippets, screenshots)
- **Describe the behavior you observed** and what behavior you expected
- **Include your environment details**: Node.js version, OS, package manager (bun/pnpm)

Use the [Bug Report template](https://github.com/elizaOS/eliza/issues/new?template=bug_report.md) to create your issue.

### Suggesting Features ✨

Feature suggestions are welcome! Please provide:

- **Clear use case**: What problem does this solve?
- **Detailed description**: How should it work?
- **Possible alternatives**: Have you considered other approaches?
- **Additional context**: Any examples or mockups?

### Improving Documentation 📚

Documentation improvements are always welcome! This includes:

- Fixing typos or unclear instructions
- Adding examples or clarifications
- Translating documentation
- Adding missing API documentation

### Pull Requests 🚀

1. **Fork the repository** and create your branch from `main`
2. **Install dependencies**: `bun install` (we use Bun as the primary package manager)
3. **Make your changes** following our coding standards
4. **Add tests** if applicable
5. **Update documentation** as needed
6. **Ensure the test suite passes**: `bun run test`
7. **Submit a pull request** using our PR template

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v23+ (we require Node 23.3.0 specifically)
- [Bun](https://bun.sh/) v1.3.5+ (recommended)
- [Git](https://git-scm.com/)

> **Windows users**: Please use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install)

### Quick Start

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/eliza.git
cd eliza

# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun run test
```

### Project Structure

```
/
├── packages/
│   ├── agent/          # Core agent runtime
│   ├── client/         # React web UI
│   ├── cli/            # Command-line interface
│   ├── core/           # Core utilities and basic-capabilities plugin
│   ├── server/         # Express.js backend
│   ├── plugin-sql/     # Database adapter (Postgres, PGLite, SQLite)
│   └── ...             # Additional plugins
├── docs/               # Documentation
└── examples/           # Example projects
```

## Coding Standards

### TypeScript

- We use TypeScript for all new code
- Enable strict mode in your editor
- Follow the existing code style (use Prettier/ESLint)

### Commit Messages

We follow conventional commits:

```
type(scope): subject

body (optional)

footer (optional)
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process or auxiliary tool changes

Examples:
```
feat(plugin-sql): add connection pooling support

fix(agent): resolve memory leak in message processing

docs(readme): add Windows WSL2 installation guide
```

### Testing

- Write tests for new features
- Ensure existing tests pass before submitting PR
- Run `bun run test` to verify

## Plugin Development

Want to create a plugin? Check out:
- [Plugin Development Guide](docs/PLUGIN_DEVELOPMENT.md)
- [Plugin Registry](https://github.com/elizaOS-plugins/registry)

## Getting Help

- 📚 [Documentation](https://docs.elizaos.ai/)
- 💬 [Discord](https://discord.gg/ai16z) - Join #development-feed
- 🐦 [Twitter/X](https://twitter.com/elizaOS)

## Recognition

Contributors will be:
- Listed in our [Contributors](https://github.com/elizaos/eliza/graphs/contributors) section
- Added to the Discord contributor channel
- Mentioned in release notes for significant contributions

---

**Thank you for contributing to elizaOS!** 🙏

Every contribution, no matter how small, helps make elizaOS better for everyone.
