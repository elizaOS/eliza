{
  description = "Self-hosted Firecrawl ohne Docker";

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
            # Node.js Runtime
            nodejs_22
            pnpm
            
            # Datenbanken (lokal starten)
            redis
            postgresql_16
            
            # Playwright dependencies für Browser-Rendering
            chromium
            
            # Build tools
            git
            curl
            jq
          ];

          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.chromium}/bin"
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            
            # Lokale Datenverzeichnisse
            export FIRECRAWL_DATA_DIR="$PWD/.firecrawl-data"
            export REDIS_DATA="$FIRECRAWL_DATA_DIR/redis"
            export PGDATA="$FIRECRAWL_DATA_DIR/postgres"
            
            mkdir -p "$REDIS_DATA" "$PGDATA"
            
            echo "🔥 Firecrawl Self-Hosted (Nix)"
            echo ""
            echo "📋 SETUP (einmalig):"
            echo "   1. git clone https://github.com/mendableai/firecrawl.git firecrawl-src"
            echo "   2. cd firecrawl-src/apps/api && pnpm install"
            echo ""
            echo "📋 STARTEN:"
            echo "   ./start-services.sh   # Redis + PostgreSQL starten"
            echo "   cd firecrawl-src/apps/api && pnpm run dev"
            echo ""
            echo "📋 CLI NUTZEN:"
            echo "   firecrawl --api-url http://localhost:3002 scrape https://example.com"
          '';
        };

        # Start-Script für Services
        packages.start-services = pkgs.writeShellScriptBin "start-services" ''
          #!/usr/bin/env bash
          set -e
          
          DATA_DIR="''${FIRECRAWL_DATA_DIR:-.firecrawl-data}"
          mkdir -p "$DATA_DIR/redis" "$DATA_DIR/postgres"
          
          echo "🚀 Starte Redis..."
          ${pkgs.redis}/bin/redis-server --daemonize yes --dir "$DATA_DIR/redis"
          
          echo "🚀 Starte PostgreSQL..."
          if [ ! -f "$DATA_DIR/postgres/PG_VERSION" ]; then
            ${pkgs.postgresql_16}/bin/initdb -D "$DATA_DIR/postgres"
          fi
          ${pkgs.postgresql_16}/bin/pg_ctl -D "$DATA_DIR/postgres" -l "$DATA_DIR/postgres.log" start
          
          echo ""
          echo "✅ Services laufen!"
          echo "   Redis:      localhost:6379"
          echo "   PostgreSQL: localhost:5432"
        '';
      }
    );
}
