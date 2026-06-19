# frozen_string_literal: true

# Homebrew formula for elizaOS App — personal AI assistant built on elizaOS
# Use this for the tap's Formula/elizaos-app.rb entry.
#
# Key fixes from the original:
#   - npm package name is "elizaos"
#   - URL points to correct npm registry path
#   - Added livecheck block for auto-update detection
#   - Added head for --HEAD installs from develop branch

class ElizaosApp < Formula
  desc "Personal AI assistant — cute agents for the acceleration"
  homepage "https://github.com/elizaos/elizaos-app"
  url "https://registry.npmjs.org/elizaos/-/elizaos-2.0.0-alpha.76.tgz"
  sha256 "3f3749c0e591547eac1992ae90eb20ccdc10b899dd3b9edce9801ac416e3a60a"
  license "MIT"
  head "https://github.com/elizaos/elizaos-app.git", branch: "develop"

  livecheck do
    url "https://registry.npmjs.org/elizaos"
    regex(/["']version["']:\s*["']([^"']+)["']/i)
  end

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      elizaOS App requires Node.js 22+.

      Get started:
        elizaos-app start         Start the agent runtime
        elizaos-app setup         Run workspace setup
        elizaos-app configure     Configuration guidance

      Dashboard: http://localhost:2138
      Docs:      https://docs.app.elizaos.ai
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/elizaos-app --version")
  end
end
