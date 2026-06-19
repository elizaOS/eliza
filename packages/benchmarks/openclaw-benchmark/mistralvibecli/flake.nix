{
  description = "Mistral Vibe CLI - Isolated Development Environment";

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
            # Core Tools
            coreutils
            curl
            wget
            git
            jq
            unzip
            
            # Runtime
            nodejs_22
            uv
            
            # Python with Skill Dependencies
            (python311.withPackages (ps: with ps; [
              # PDF Skills
              pypdf
              reportlab
              pdfplumber
              
              # Office Skills
              python-pptx
              python-docx
              openpyxl
              
              # Image Processing
              pillow
              
              # Data/Web
              requests
              beautifulsoup4
              pandas
              numpy
            ]))
            
            # Document Generation (for PDF/PPTX skills)
            pandoc
            texliveSmall  # LaTeX for pandoc PDF output
            
            # Build Tools
            gnumake
            gcc
          ];

          shellHook = ''
            echo "══════════════════════════════════════════════"
            echo "  🌊 MISTRAL VIBE CLI ENVIRONMENT"
            echo "══════════════════════════════════════════════"
            echo ""

            # Project Setup
            export PROJECT_ROOT="$PWD"
            export REAL_HOME="$HOME"
            
            # Isolated Home
            export ISOLATED_HOME="$PROJECT_ROOT/.isolated_home"
            export HOME="$ISOLATED_HOME"
            
            # XDG Directories
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_STATE_HOME="$HOME/.local/state"
            
            # Create Directories
            mkdir -p "$HOME/.local/bin"
            mkdir -p "$HOME/.npm-global/bin"
            mkdir -p "$XDG_CONFIG_HOME"
            mkdir -p "$XDG_DATA_HOME"
            mkdir -p "$XDG_CACHE_HOME"
            
            # Update PATH
            export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
            
            # Filter out system paths for node/npm to ensure isolation
            # (Simplified version of the one in autonomous_agent_env)
            
            # NPM Config
            npm config set prefix "$HOME/.npm-global" 2>/dev/null || true

            echo "📁 Isolated HOME: $HOME"
            echo "✅ Environment Ready"
            echo ""
          '';
        };
      });
}
