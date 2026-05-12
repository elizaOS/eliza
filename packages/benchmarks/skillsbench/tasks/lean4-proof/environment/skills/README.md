# Lean 4 Skills for Claude

[![Run in Smithery](https://smithery.ai/badge/skills/cameronfreer)](https://smithery.ai/skills?ns=cameronfreer&utm_source=github&utm_medium=badge)

Claude Skills, commands, and agents for systematic development of formal proofs in Lean 4.

## Plugins

| Plugin | Provides | Description |
|--------|----------|-------------|
| **[lean4-theorem-proving](plugins/lean4-theorem-proving/)** | Skill + 8 Commands | Core workflows, LSP integration, automation tools |
| **[lean4-memories](plugins/lean4-memories/)** | Skill | Persistent learning across sessions (requires MCP memory server) |
| **[lean4-subagents](plugins/lean4-subagents/)** | 5 Agents | Proof repair, sorry filling, axiom elimination, proof golfing |

## Quick Start

```bash
# Via Marketplace (Recommended)
/plugin marketplace add cameronfreer/lean4-skills
/plugin install lean4-theorem-proving    # Core (required)
/plugin install lean4-subagents          # Optional: specialized agents
/plugin install lean4-memories           # Optional: persistent memory
```

Skills activate automatically when you work on Lean 4 files. Commands appear in autocomplete with `/lean4-theorem-proving:` prefix.

## What You Get

- **Lean LSP integration** - Sub-second feedback vs 30s builds
- **8 commands** - `/build-lean`, `/fill-sorry`, `/repair-file`, `/golf-proofs`, `/check-axioms`, `/analyze-sorries`, `/refactor-have`, `/search-mathlib`
- **5 specialized agents** - Proof repair, sorry filling (fast + deep), axiom elimination, proof golfing
- **Automation scripts** - 16 tools for search, analysis, verification
- **mathlib patterns** - Type class management, domain-specific tactics

## Documentation

- [lean4-theorem-proving/README.md](plugins/lean4-theorem-proving/README.md) - Core skill guide
- [lean4-subagents/README.md](plugins/lean4-subagents/README.md) - Specialized agents
- [lean4-memories/README.md](plugins/lean4-memories/README.md) - Memory integration
- [INSTALLATION.md](INSTALLATION.md) - Platform-specific setup, LSP server

## Changelog

**v3.4.1** (January 2026)
- Expanded `/refactor-have` to support both inlining and extraction
- Added mathlib style guidance for idiomatic proofs

**v3.4.0** (January 2026)
- Added `/refactor-have` command for extracting long have-blocks
- Added `/repair-interactive` command for interactive proof repair
- Added `lean4-sorry-filler-deep` agent for complex sorries
- Improved LSP integration and error handling

**v3.3.0** (December 2025)
- Added `/repair-file` command for full-file compiler-guided repair
- Streamlined agent descriptions per Anthropic best practices

**v3.2.0** (November 2025)
- Enhanced mathlib search capabilities
- Improved type class instance resolution patterns

**v3.1.0** (October 2025)
- Restructured as Claude Code marketplace with 3 plugins

## Contributing

Contributions welcome! Open an issue or PR at https://github.com/cameronfreer/lean4-skills

## License

MIT License - see [LICENSE](LICENSE)
