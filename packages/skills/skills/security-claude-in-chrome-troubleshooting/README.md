# Claude in Chrome Troubleshooting

Diagnose and fix Claude in Chrome MCP extension connectivity issues.

**Original Author:** [@jeffzwang](https://github.com/jeffzwang) from [@ExaAILabs](https://github.com/ExaAILabs)
**Enhanced by:** Trail of Bits

## When to Use

- `mcp__claude-in-chrome__*` tools fail with "Browser extension is not connected"
- Browser automation works erratically or times out
- After updating Claude Code or Claude.app
- When switching between Claude Code CLI and Claude.app (Cowork)

## What It Does

- Explains the Claude.app vs Claude Code native host conflict
- Provides toggle script to switch between the two
- Quick diagnosis commands
- Full reset procedure
- Covers edge cases (multiple profiles, stale wrappers, TMPDIR issues)

## Installation

```
/plugin install trailofbits/skills/plugins/claude-in-chrome-troubleshooting
```

## License

This work is licensed under a [Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/).
