#!/bin/bash
set -e

echo "══════════════════════════════════════════════"
echo "  🚀 SETUP: Autonomous OpenCode Agent"
echo "══════════════════════════════════════════════"
echo ""

# Sicherstellen dass wir in der Nix-Umgebung sind
if [ -z "$ISOLATED_HOME" ]; then
    echo "❌ Fehler: Bitte zuerst 'nix develop' ausführen!"
    echo "   Dann: './setup.sh'"
    exit 1
fi

echo "📁 Installiere nach: $HOME"
echo ""

# 1. OpenCode installieren
echo ">>> Installiere OpenCode..."
if [ ! -f "$HOME/.opencode/bin/opencode" ]; then
    curl -fsSL https://opencode.ai/install | bash
else
    echo "    OpenCode bereits installiert."
fi

# 2. Firecrawl installieren
echo ""
echo ">>> Installiere Firecrawl..."
if ! command -v firecrawl &> /dev/null; then
    npm install -g firecrawl-cli
else
    echo "    Firecrawl bereits installiert."
fi

# 3. OpenCode Config Manager (OCCM) installieren
echo ""
echo ">>> Installiere OpenCode Config Manager (OCCM)..."
if [ ! -f "$HOME/.local/bin/occm" ]; then
    VERSION="v1.7.1"
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    curl -L "https://github.com/icysaintdx/OpenCode-Config-Manager/releases/download/$VERSION/OCCM_${VERSION}-Linux-x64.tar.gz" -o "$BIN_DIR/occm.tar.gz"
    tar -xzf "$BIN_DIR/occm.tar.gz" -C "$BIN_DIR"
    ln -sf "$BIN_DIR/OCCM_${VERSION}/OCCM_${VERSION}" "$BIN_DIR/occm"
    rm "$BIN_DIR/occm.tar.gz"
    echo "    OCCM installiert."
else
    echo "    OCCM bereits installiert."
fi

# 4. Antigravity Konfiguration
echo ""
echo ">>> Konfiguriere Antigravity Auth und Models..."

CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$CONFIG_DIR"

# Provider Config
cat <<EOF > /tmp/antigravity_provider.json
{
  "google": {
    "models": {
      "antigravity-gemini-3-pro": {
        "name": "Gemini 3 Pro (Antigravity)",
        "limit": { "context": 1048576, "output": 65535 },
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
        "variants": {
          "low": { "thinkingLevel": "low" },
          "high": { "thinkingLevel": "high" }
        }
      },
      "antigravity-gemini-3-flash": {
        "name": "Gemini 3 Flash (Antigravity)",
        "limit": { "context": 1048576, "output": 65536 },
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
        "variants": {
          "minimal": { "thinkingLevel": "minimal" },
          "low": { "thinkingLevel": "low" },
          "medium": { "thinkingLevel": "medium" },
          "high": { "thinkingLevel": "high" }
        }
      },
      "antigravity-claude-sonnet-4-5": {
        "name": "Claude Sonnet 4.5 (Antigravity)",
        "limit": { "context": 200000, "output": 64000 },
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
      },
      "antigravity-claude-sonnet-4-5-thinking": {
        "name": "Claude Sonnet 4.5 Thinking (Antigravity)",
        "limit": { "context": 200000, "output": 64000 },
        "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
        "variants": {
          "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
          "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
        }
      }
    }
  }
}
EOF

# OpenCode Config erstellen/aktualisieren
CONFIG_FILE="$CONFIG_DIR/opencode.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "{}" > "$CONFIG_FILE"
fi

# Firecrawl MCP Config
cat <<EOF > /tmp/firecrawl_mcp.json
{
  "mcp": {
    "firecrawl": {
      "type": "local",
      "command": [
        "env",
        "FIRECRAWL_API_URL=http://localhost:3002",
        "npx",
        "-y",
        "firecrawl-mcp"
      ]
    }
  }
}
EOF

tmp=$(mktemp)
jq -s '.[0] * {
  plugin: ((.[0].plugin // []) + ["opencode-antigravity-auth@latest"] | unique),
  provider: .[1]
} * .[2]' "$CONFIG_FILE" /tmp/antigravity_provider.json /tmp/firecrawl_mcp.json > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Antigravity Settings
cat <<EOF > "$CONFIG_DIR/antigravity.json"
{
  "\$schema": "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/assets/antigravity.schema.json",
  "account_selection_strategy": "round-robin",
  "switch_on_first_rate_limit": true,
  "pid_offset_enabled": true,
  "switch_on_error": true
}
EOF

# 5. Firecrawl Self-Hosted Setup
echo ""
echo ">>> Konfiguriere Firecrawl (Self-Hosted)..."
FIRECRAWL_DIR="$(dirname "$0")/firecrawl-local"

if [ -d "$FIRECRAWL_DIR" ]; then
    chmod +x "$FIRECRAWL_DIR"/*.sh
    echo "    Starte Firecrawl Setup..."
    (cd "$FIRECRAWL_DIR" && ./setup.sh)
    
    echo "    Starte Firecrawl Services..."
    (cd "$FIRECRAWL_DIR" && ./start.sh)
    
    # Warte kurz auf Verfügbarkeit
    echo "    Warte auf API..."
    sleep 5
else
    echo "❌ Firecrawl Verzeichnis nicht gefunden!"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ SETUP ABGESCHLOSSEN"
echo "══════════════════════════════════════════════"
echo ""
echo "Nächster Schritt:"
echo "  opencode auth login"
echo ""
echo "Danach:"
echo "  opencode               (Interaktiv)"
echo "  ./ralphy-wrapper.sh    (Autonom mit PRD.md)"
echo ""
