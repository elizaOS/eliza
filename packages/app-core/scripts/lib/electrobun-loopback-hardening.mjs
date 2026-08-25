import fs from "node:fs";
import path from "node:path";

const SOCKET_SOURCE = path.join("api", "bun", "core", "Socket.ts");
const LOOPBACK_HOSTNAME = 'hostname: "127.0.0.1",';
const SERVE_WITHOUT_HOST_RE =
  /(server\s*=\s*Bun\.serve<[^>]+>\(\{\r?\n)([\t ]+)(port,)/;

function socketCandidates(packageRoot, fileSystem) {
  const candidates = [path.join(packageRoot, "dist", SOCKET_SOURCE)];
  for (const entry of fileSystem.readdirSync(packageRoot, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && entry.name.startsWith("dist-")) {
      candidates.push(path.join(packageRoot, entry.name, SOCKET_SOURCE));
    }
  }
  return candidates.filter((candidate) => fileSystem.existsSync(candidate));
}

/**
 * Electrobun 1.18.1 leaves its private renderer RPC server host unspecified,
 * which makes Bun listen on every interface. Patch both the shared source and
 * any platform core downloaded by the CLI. A changed upstream shape fails
 * closed instead of silently shipping a wildcard listener.
 */
export function hardenElectrobunRpcSockets(packageRoot, fileSystem = fs) {
  const candidates = socketCandidates(packageRoot, fileSystem);
  const canonical = path.join(packageRoot, "dist", SOCKET_SOURCE);
  if (!candidates.includes(canonical)) {
    throw new Error(
      `[electrobun-loopback] required RPC source is missing: ${canonical}`,
    );
  }

  const changed = [];
  for (const candidate of candidates) {
    const source = fileSystem.readFileSync(candidate, "utf8");
    if (source.includes(LOOPBACK_HOSTNAME)) continue;
    if (!SERVE_WITHOUT_HOST_RE.test(source)) {
      throw new Error(
        `[electrobun-loopback] cannot prove or patch loopback binding in ${candidate}`,
      );
    }
    const hardened = source.replace(
      SERVE_WITHOUT_HOST_RE,
      `$1$2${LOOPBACK_HOSTNAME}\n$2$3`,
    );
    fileSystem.writeFileSync(candidate, hardened);
    changed.push(candidate);
  }
  return changed;
}
