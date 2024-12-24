{
  description = "Node.js development environment with NVM and PNPM";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      fallbackNodeVersion = "23.3.0";
      fallbackPnpmVersion = "9.14.4";

      # Read and parse package.json
      packageJson = let
        path = ./package.json;
      in
        if builtins.pathExists path
        then builtins.fromJSON (builtins.readFile path)
        else {
          engines = {node = fallbackNodeVersion;};
          packageManager = "pnpm@${fallbackPnpmVersion}";
        }; # Default if no package.json

      # Extract Node.js version from engines field
      nodeVersion = let
        engineVersion = packageJson.engines.node or fallbackNodeVersion;
        cleanVersion = builtins.replaceStrings ["^" ">" "=" "~" " "] ["" "" "" "" ""] engineVersion;
      in
        cleanVersion;

      # Extract PNPM version from packageManager field
      # Handles format: "pnpm@x.y.z+sha512..." or "pnpm@x.y.z"
      pnpmVersion = let
        packageManager = packageJson.packageManager or "pnpm@${fallbackPnpmVersion}";
        # First split on '+' to remove SHA, then extract version
        withoutSha = builtins.head (builtins.split "[+]" packageManager);
        versionMatch = builtins.match "pnpm@([0-9]+[.][0-9]+[.][0-9]+).*" withoutSha;
      in
        if versionMatch == null
        then fallbackPnpmVersion
        else builtins.head versionMatch;
    in {
      devShell = pkgs.mkShell {
        buildInputs = with pkgs; [
          curl
          git
        ];

        shellHook = ''
          # Install nvm if it's not already installed
          export NVM_DIR="$HOME/.nvm"
          if [ ! -d "$NVM_DIR" ]; then
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
          fi

          # Load nvm
          [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

          # Install and use the specified version if not already installed
          if ! nvm ls ${nodeVersion} >/dev/null 2>&1; then
            nvm install ${nodeVersion}
          fi
          nvm use ${nodeVersion}

          # Enable and configure corepack for PNPM
          corepack enable
          corepack prepare pnpm@${pnpmVersion} --activate

          # Setup PNPM environment
          export PNPM_HOME="$HOME/.local/share/pnpm"
          export PATH="$PNPM_HOME:$PATH"

          # Get clean versions for comparison
          NODE_ACTUAL=$(node --version | sed 's/^v//')
          PNPM_ACTUAL=$(pnpm --version)

          echo "🤖 Development environment loaded 🚀"
          echo "------------------------------------------"
          echo "package.json version(s) = environment:"

          if [ "$NODE_ACTUAL" = "${nodeVersion}" ]; then
            echo "✅ Node.js (v${nodeVersion})"
          else
            echo "❌ Node.js (v${nodeVersion} != v$NODE_ACTUAL)"
          fi

          if [ "$PNPM_ACTUAL" = "${pnpmVersion}" ]; then
            echo "✅ PNPM (v${pnpmVersion})"
          else
            echo "❌ PNPM (v${pnpmVersion} != v$PNPM_ACTUAL)"
          fi

          echo """
          🏗️  Quickstart Guide:
          --------------------
          ┌─> 1. pnpm i      (Install dependencies)
          │   2. pnpm build  (Build project)
          └─  3. pnpm clean  (Clear Artifacts, for a fresh start)
              4. pnpm test   (Run tests)

          For more commands, run: pnpm --help
          """
        '';
      };
    });
}
