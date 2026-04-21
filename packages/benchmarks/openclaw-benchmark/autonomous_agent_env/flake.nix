{
  description = "Autonomous OpenCode Agent - Fully Isolated Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Basis-Tools
            coreutils
            curl
            wget
            git
            jq
            nodejs_22
            
            # GUI/X11 Support für OCCM
            xorg.libX11
            xorg.libXcursor
            xorg.libXrandr
            xorg.libXi
            libGL
          ];

          shellHook = ''
            echo "══════════════════════════════════════════════"
            echo "  🤖 AUTONOMOUS OPENCODE AGENT ENVIRONMENT"
            echo "══════════════════════════════════════════════"
            echo ""

            # Projektroot
            export PROJECT_ROOT="$PWD"
            
            # Echtes HOME sichern
            export REAL_HOME="$HOME"
            
            # ISOLIERTES HOME
            export ISOLATED_HOME="$PROJECT_ROOT/.isolated_home"
            export HOME="$ISOLATED_HOME"
            
            # WICHTIG: Display für GUIs (OCCM) durchreichen
            # DOUBLE ESCAPED for Nix interpolation of shell syntax
            export DISPLAY=''${DISPLAY:-":0"}
            
            # XDG-Verzeichnisse
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_STATE_HOME="$HOME/.local/state"
            
            # Verzeichnisse erstellen
            mkdir -p "$HOME/.local/bin"
            mkdir -p "$HOME/.opencode/bin"
            mkdir -p "$HOME/.npm-global/bin"
            mkdir -p "$XDG_CONFIG_HOME/opencode"
            mkdir -p "$XDG_DATA_HOME"
            mkdir -p "$XDG_CACHE_HOME"
            
            # PATH für isolierte Binaries (als erstes!)
            export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
            
            # WICHTIG: Entferne System-Pfade für OpenCode/Node um Fallback zu verhindern
            # Wir entfernen Pfade die "/.opencode/bin" oder "/.npm-global/bin" im echten Home enthalten
            export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "$REAL_HOME/.opencode" | grep -v "$REAL_HOME/.npm-global" | grep -v "$REAL_HOME/.local/bin" | tr '\n' ':')
            
            # npm konfigurieren
            npm config set prefix "$HOME/.npm-global" 2>/dev/null || true

            echo "📁 Isoliertes HOME: $HOME"
            echo "📁 Config: $XDG_CONFIG_HOME"
            echo ""
            
            # Prüfe ob Setup nötig
            if [ ! -f "$HOME/.opencode/bin/opencode" ]; then
              echo "⚠️  OpenCode nicht installiert."
              echo "   Führe './setup.sh' aus um die Umgebung einzurichten."
              echo ""
            else
              echo "✅ OpenCode verfügbar"
            fi
            
            if ! command -v firecrawl &> /dev/null; then
              echo "⚠️  Firecrawl nicht installiert. Führe './setup.sh' aus."
            else
              echo "✅ Firecrawl verfügbar"
            fi
            
            echo ""
            echo "══════════════════════════════════════════════"
            echo "  Befehle:"
            echo "    ./setup.sh          - Installiert OpenCode + Firecrawl"
            echo "    opencode            - Starte OpenCode"
            echo "    opencode auth login - Authentifizierung"
            echo "══════════════════════════════════════════════"
          '';
        };
      });
}
