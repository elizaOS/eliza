# Homebrew distribution

The authoritative formula and cask live in
[`elizaOS/homebrew-tap`](https://github.com/elizaOS/homebrew-tap). This
repository deliberately carries no versioned Ruby definitions: checked-in
copies become stale independently of the external tap and can make a syntax-only
packaging check look healthy while users receive old artifacts.

Stable releases call `.github/workflows/update-homebrew.yml` after the exact npm
release is observable. That workflow sends the stable version to the tap's
`update-homebrew` repository-dispatch handler, where the formula/cask URLs,
digests, Node requirement, installation, and audits are generated and tested.
The dispatch fails if its credential or stable version is invalid.

Users install from the authoritative tap:

```bash
brew tap elizaOS/tap
brew install elizaos-app
brew install --cask elizaos-app
```
