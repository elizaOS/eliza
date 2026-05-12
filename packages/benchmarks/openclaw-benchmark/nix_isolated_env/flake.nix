{
  description = "Fully Isolated Development Environment (Tool-Agnostic)";

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
          # =============================================
          # BASIS-TOOLS (von Nix verwaltet, garantiert isoliert)
          # =============================================
          buildInputs = with pkgs; [
            # Basis
            coreutils
            curl
            wget
            git
            jq
            
            # Node.js (falls benötigt - Nix garantiert Version)
            nodejs_22
          ];

          # =============================================
          # VOLLSTÄNDIGE HOME-ISOLATION
          # =============================================
          # WARUM DAS FUNKTIONIERT:
          # Linux-Tools nutzen $HOME für alles:
          # - ~/.local/bin (Binaries)
          # - ~/.config (Konfiguration)
          # - ~/.cache (Cache)
          # Wenn wir $HOME ändern BEVOR ein Tool läuft,
          # nutzt es automatisch das neue Verzeichnis.
          #
          # Beispiel: `curl ... | bash` von OpenCode
          # Das Skript macht intern: mkdir -p $HOME/.local/bin
          # Da $HOME = .isolated_home ist, geht es nach:
          # .isolated_home/.local/bin/
          # =============================================

          shellHook = ''
            echo "══════════════════════════════════════════════"
            echo "  🔒 ISOLIERTE ENTWICKLUNGSUMGEBUNG"
            echo "══════════════════════════════════════════════"
            echo ""

            # Projektroot merken
            export PROJECT_ROOT="$PWD"
            
            # Echtes HOME sichern (für Browser-Auth falls nötig)
            export REAL_HOME="$HOME"
            
            # NEUES ISOLIERTES HOME
            export ISOLATED_HOME="$PROJECT_ROOT/.isolated_home"
            export HOME="$ISOLATED_HOME"
            
            # XDG-Verzeichnisse (Standard-Linux-Pfade)
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_STATE_HOME="$HOME/.local/state"
            
            # Verzeichnisse erstellen
            mkdir -p "$HOME/.local/bin"
            mkdir -p "$HOME/.npm-global/bin"
            mkdir -p "$XDG_CONFIG_HOME"
            mkdir -p "$XDG_DATA_HOME"
            mkdir -p "$XDG_CACHE_HOME"
            mkdir -p "$XDG_STATE_HOME"
            
            # PATH: Isolierte Binaries zuerst
            export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
            
            # npm konfigurieren (falls node genutzt wird)
            npm config set prefix "$HOME/.npm-global" 2>/dev/null || true

            echo "📁 Isoliertes HOME:  $HOME"
            echo "📁 Echtes HOME:      $REAL_HOME (für Browser-Auth)"
            echo ""
            echo "✅ Alle Tools die du jetzt installierst landen in:"
            echo "   $ISOLATED_HOME/"
            echo ""
            echo "💡 Beispiele:"
            echo "   curl ... | bash  → geht nach $HOME/.local/bin/"
            echo "   npm install -g X → geht nach $HOME/.npm-global/"
            echo "   pip install X    → geht nach $HOME/.local/"
            echo ""
            echo "══════════════════════════════════════════════"
          '';
        };
      });
}
