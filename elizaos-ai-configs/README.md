# ElizaOS AI Development Configuration Suite

Complete configuration for all major AI coding tools - Windsurf IDE, Claude Code, OpenAI Codex, GitHub Copilot, and Cursor IDE.

## Directory Structure

```
elizaos-ai-configs/
├── .windsurf/                          # Windsurf IDE Configuration
│   ├── rules/
│   │   ├── elizaos-v2-main.md          # Core development principles
│   │   ├── elizaos-architecture.md      # Component specifications
│   │   └── elizaos-testing.md          # Testing infrastructure
│   └── workflows/
│       ├── elizaos-development.yaml    # Main development workflow
│       ├── elizaos-testing.yaml        # Testing automation
│       └── elizaos-component.yaml      # Component creation
├── .claude/                            # Claude Code Configuration
│   ├── commands/                       # Slash Commands
│   │   ├── dev.md                      # /project:dev
│   │   ├── test.md                     # /project:test
│   │   ├── bugfix.md                   # /project:bugfix
│   │   ├── validate.md                 # /project:validate
│   │   ├── review.md                   # /project:review
│   │   ├── component.md                # /project:component
│   │   └── elizaos/                    # Namespaced Commands
│   │       ├── action.md               # /project:elizaos:action
│   │       ├── provider.md             # /project:elizaos:provider
│   │       └── evaluator.md            # /project:elizaos:evaluator
│   └── COMMANDS.md                     # Command reference
├── codex/                              # OpenAI Codex Configuration
│   ├── CODEX.md                        # Project-specific instructions
│   ├── global-instructions.md          # User-level preferences
│   └── config-setup.md                 # CLI configuration guide
├── github-copilot/                     # GitHub Copilot Configuration
│   ├── .github/
│   │   ├── copilot-instructions.md     # Repository-wide instructions
│   │   ├── instructions/
│   │   │   ├── actions.md              # Action development
│   │   │   ├── providers.md            # Provider development
│   │   │   ├── evaluators.md           # Evaluator development
│   │   │   └── git-commit.md           # Commit conventions
│   │   └── prompts/
│   │       ├── create-action.prompt.md # Action creation workflow
│   │       └── run-tests.prompt.md     # Testing workflow
│   ├── .vscode/
│   │   └── settings.json               # VS Code integration
│   └── setup-guide.md                  # Configuration guide
├── cursor/                             # Cursor IDE Configuration
│   ├── .cursorrules                    # Legacy format (complete rules)
│   ├── .cursor/
│   │   └── rules/
│   │       ├── index.mdc               # Core rules (always applied)
│   │       ├── actions.mdc             # Action development (context-aware)
│   │       └── testing.mdc             # Testing rules (context-aware)
│   └── setup-guide.md                  # Installation guide
├── CLAUDE.md                           # Claude Code main configuration
└── README.md                           # This file
```

## Universal ElizaOS Features

All tools enforce the same development principles:
- ✅ **Flow - Always Plan First** methodology
- ✅ **No Stubs or Incomplete Code** rule
- ✅ **Test-Driven Development** with `elizaos test` commands
- ✅ **Bun Runtime** validation (never Node.js)
- ✅ **@elizaos/core** dependency patterns (no circular dependencies)
- ✅ **Agent Perspective** in abstractions (Channel→Room, Server→World)
- ✅ **Component Specifications** (Actions, Providers, Evaluators, Tasks, Services)
- ✅ **TypeScript Standards** with comprehensive error handling

## Setup Instructions

### For Each Tool:
1. **Windsurf:** Copy `.windsurf/` to your ElizaOS project root
2. **Claude Code:** Copy `.claude/` to your ElizaOS project root and `CLAUDE.md` to root
3. **Codex:** Follow setup guide in `codex/config-setup.md`
4. **GitHub Copilot:** Copy `github-copilot/.github/` and `github-copilot/.vscode/` to project root
5. **Cursor:** Copy either `cursor/.cursorrules` OR `cursor/.cursor/` to project root

## Benefits

- **Consistent Experience** - Same ElizaOS patterns across all AI tools
- **Tool Optimization** - Each tool configured for its specific strengths
- **Quality Assurance** - Automated enforcement of ElizaOS principles
- **Complete Coverage** - From planning to implementation to testing

This configuration suite ensures consistent, high-quality code across all major AI coding tools while enforcing your exact ElizaOS development methodology and architectural constraints.
