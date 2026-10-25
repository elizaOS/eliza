/**
 * Selects and verifies the pinned Discord Opus N-API artifact for a Linux
 * container install, then preserves that selection for Bun's runtime loader.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const OPUS_VERSION = "0.10.0";

const OPUS_ASSETS = {
  amd64: {
    directory: "node-v108-napi-v3-linux-x64-musl-1.2.5",
    sha256: "d5396d0f6ba4f07851c8fa0f98183b19bb856c9bfbb150d02984ebb54a2140df",
  },
  arm64: {
    directory: "node-v108-napi-v3-linux-arm64-musl-1.2.5",
    sha256: "cb9194a8a785434918a42312d4d9f04167f7e316cf577f487c8e2ebfbdd12080",
  },
} as const;

type SupportedDockerArch = keyof typeof OPUS_ASSETS;

function supportedDockerArch(value: string): SupportedDockerArch {
  if (value === "amd64" || value === "arm64") return value;
  throw new Error(
    `@discordjs/opus ${OPUS_VERSION} has no verified Alpine prebuild for Docker architecture ${value}`,
  );
}

export async function selectOpusPrebuild(
  serviceDirectory: string,
  dockerArchitecture: string,
): Promise<void> {
  const asset = OPUS_ASSETS[supportedDockerArch(dockerArchitecture)];
  const packageRoot = path.join(
    serviceDirectory,
    "node_modules",
    "@discordjs",
    "opus",
  );
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = (await Bun.file(manifestPath).json()) as {
    version?: string;
    binary?: { module_path?: string };
  };
  if (manifest.version !== OPUS_VERSION) {
    throw new Error(
      `expected @discordjs/opus ${OPUS_VERSION}, found ${manifest.version ?? "unknown"}`,
    );
  }
  if (!manifest.binary) {
    throw new Error("installed @discordjs/opus manifest lacks binary metadata");
  }

  const prebuildRoot = path.join(packageRoot, "prebuild");
  const installed = readdirSync(prebuildRoot).filter((entry) =>
    existsSync(path.join(prebuildRoot, entry, "opus.node")),
  );
  if (installed.length !== 1 || installed[0] !== asset.directory) {
    throw new Error(
      `expected only verified Opus build ${asset.directory}, found ${installed.join(", ") || "none"}`,
    );
  }

  const binaryPath = path.join(prebuildRoot, asset.directory, "opus.node");
  const digest = createHash("sha256")
    .update(new Uint8Array(await Bun.file(binaryPath).arrayBuffer()))
    .digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(
      `Opus prebuild integrity mismatch for ${asset.directory}: expected ${asset.sha256}, found ${digest}`,
    );
  }

  const runtimeDirectory = asset.directory.replace(
    "napi-v3",
    "napi-v{napi_build_version}",
  );
  manifest.binary.module_path = `./prebuild/${runtimeDirectory}/`;
  await Bun.write(manifestPath, JSON.stringify(manifest));
}

if (import.meta.main) {
  const serviceDirectory = Bun.argv[2];
  const dockerArchitecture = Bun.argv[3];
  if (!serviceDirectory || !dockerArchitecture) {
    throw new Error(
      "usage: bun select-opus-prebuild.ts <service-directory> <docker-architecture>",
    );
  }
  await selectOpusPrebuild(serviceDirectory, dockerArchitecture);
}
