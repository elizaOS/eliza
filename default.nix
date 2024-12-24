{
  pkgs ? import <nixpkgs> {},
  system ? builtins.currentSystem,
  sha256 ? null,
}: let
  packageJson = builtins.fromJSON (builtins.readFile ./package.json);
  nodeVersion = builtins.replaceStrings ["^" "~"] ["" ""] packageJson.engines.node;
  pnpmVersion = builtins.head (builtins.match "pnpm@([0-9.]+).*" packageJson.packageManager);

  getPlatformString = platform:
    if platform == "nodejs"
    then
      if pkgs.stdenv.isDarwin
      then
        if pkgs.stdenv.isAarch64
        then "darwin-arm64"
        else "darwin-x64"
      else if pkgs.stdenv.isAarch64
      then "linux-arm64"
      else "linux-x64"
    else if pkgs.stdenv.isDarwin
    then
      if pkgs.stdenv.isAarch64
      then "macos-arm64"
      else "macos-x64"
    else if pkgs.stdenv.isAarch64
    then "linux-arm64"
    else "linux-x64";
in rec {
  buildNodePackages = pkgs: {
    nodejs = pkgs.stdenv.mkDerivation {
      name = "nodejs-${nodeVersion}";
      src = pkgs.fetchurl {
        url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${getPlatformString "nodejs"}.tar.xz";
        inherit sha256;
      };
      buildInputs = [pkgs.python3];
      sourceRoot = ".";
      dontUnpack = false;
      dontBuild = true;
      installPhase = ''
        mkdir -p $out
        mv node-v${nodeVersion}-* node
        cp -r node/* $out/
        chmod +x $out/bin/node
        ln -s $out/bin/node $out/bin/nodejs
      '';
    };

    pnpm = pkgs.stdenv.mkDerivation {
      name = "pnpm-${pnpmVersion}";
      src = pkgs.fetchurl {
        url = "https://github.com/pnpm/pnpm/releases/download/v${pnpmVersion}/pnpm-${getPlatformString "pnpm"}";
        inherit sha256;
      };
      dontUnpack = true;
      dontStrip = true;
      installPhase = ''
        mkdir -p $out/bin
        cp $src $out/bin/pnpm
        chmod +x $out/bin/pnpm
      '';
    };
  };
}
