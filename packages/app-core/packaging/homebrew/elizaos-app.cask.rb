# frozen_string_literal: true

# Homebrew Cask for the elizaOS App desktop app (DMG).
# Use this for the tap's Casks/elizaos-app.cask.rb entry.
#
# Key fixes from the original:
#   - URL matches actual release asset naming (canary-macos-{arch}-ElizaOSApp-canary.dmg)
#   - App identifier uses ai.elizaos.app (from actual metadata)
#   - SHA256 for both architectures

cask "elizaos-app" do
  arch arm: "arm64", intel: "x64"

  version "2.0.0-alpha.84"

  on_arm do
    sha256 "a348cc3c619e8445270e4a2ebfc07c14ec56384893c48452832dadb01d17448b"
  end

  on_intel do
    sha256 "5a40d3a4f9e7a7302cf4f4102ed7dbd81c8cb57083d1ff8b94e167f214d4d9f6"
  end

  url "https://github.com/elizaos/elizaos-app/releases/download/v#{version}/canary-macos-#{arch}-ElizaOSApp-canary.dmg",
      verified: "github.com/elizaos/elizaos-app/"

  name "elizaOS App"
  desc "Personal AI assistant — cute agents for the acceleration"
  homepage "https://github.com/elizaos/elizaos-app"

  livecheck do
    url "https://github.com/elizaos/elizaos-app/releases"
    strategy :github_latest
    regex(/v?(\d+(?:\.\d+)+(?:-[a-z]+\.\d+)?)/i)
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "ElizaOSApp.app"

  zap trash: [
    "~/Library/Application Support/ElizaOSApp",
    "~/Library/Caches/ai.elizaos.app",
    "~/Library/Caches/ai.elizaos.app.ShipIt",
    "~/Library/Preferences/ai.elizaos.app.plist",
    "~/Library/Saved Application State/ai.elizaos.app.savedState",
    "~/.elizaos-app",
  ]

  caveats <<~EOS
    elizaOS App desktop app has been installed.

    On first launch, you'll be guided through setup to:
    - Choose your agent's name and personality
    - Connect an AI provider (Anthropic, OpenAI, Ollama, etc.)

    The CLI is also available via: brew install elizaos-app (without --cask)
  EOS
end
