# Homebrew Distribution

This directory contains Homebrew formula and cask definitions for elizaOS App.

## Files

- `elizaos-app.rb` — Formula for the CLI tool (installed via npm)
- `elizaos-app.cask.rb` — Cask for the desktop app (DMG installer)

## Setup

### 1. Create Homebrew Tap Repository

Create a new repo: `elizaos/homebrew-elizaos-app`

Structure:
```
homebrew-elizaos-app/
├── Formula/
│   └── elizaos-app.rb
├── Casks/
│   └── elizaos-app.cask.rb
└── README.md
```

### 2. Update SHA256 Hashes

Before publishing, replace placeholder hashes:

**For the cask (DMG files):**
```bash
# Download and hash ARM64 DMG
curl -sL https://github.com/elizaos/elizaos-app/releases/download/v2.0.0-beta.0/ElizaOSApp-2.0.0-beta.0-arm64.dmg | shasum -a 256

# Download and hash Intel DMG
curl -sL https://github.com/elizaos/elizaos-app/releases/download/v2.0.0-beta.0/ElizaOSApp-2.0.0-beta.0.dmg | shasum -a 256
```

**For the formula (npm tarball):**
```bash
curl -sL https://registry.npmjs.org/elizaos/-/elizaos-2.0.0-beta.0.tgz | shasum -a 256
```

### 3. Users Can Install

```bash
# Add tap
brew tap elizaos/elizaos-app

# Install desktop app
brew install --cask elizaos-app

# Or install CLI only
brew install elizaos-app
```

## Auto-Update Workflow

See the publishing guide at `../PUBLISHING_GUIDE.md` for full instructions.

## Testing Locally

```bash
# Test formula syntax
brew audit --strict elizaos-app.rb

# Test cask syntax
brew audit --cask --strict elizaos-app.cask.rb

# Test installation (from local file)
brew install --formula ./elizaos-app.rb
brew install --cask ./elizaos-app.cask.rb
```

## Notes

- The cask requires macOS Monterey (12.0) or later
- The formula requires Node.js 22+ (installed as dependency)
- Both support auto-updates via Homebrew's built-in mechanisms
- Desktop app also has built-in auto-update via the native Electrobun updater
