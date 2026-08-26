import fs from "node:fs";
import path from "node:path";

const SOCKET_SOURCE = path.join("api", "bun", "core", "Socket.ts");
const LOOPBACK_HOSTNAME = 'hostname: "127.0.0.1",';
const EXPLICIT_PORT_MARKER = "Bun.env.ELECTROBUN_RPC_PORT";
const SERVE_WITHOUT_HOST_RE =
  /(server\s*=\s*Bun\.serve<[^>]+>\(\{\r?\n)([\t ]+)(port,)/;
const DEFAULT_PORT_RANGE_RE =
  /([\t ]*)const startPort = 50000;\r?\n\1const endPort = 65535;/;

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
 * Electrobun 1.18.1 leaves its private renderer RPC server host unspecified
 * and silently scans upward from port 50000. Patch both the shared source and
 * any platform core downloaded by the CLI so the host is loopback-only and an
 * explicit port is an exclusive ownership contract. A changed upstream shape
 * fails closed instead of shipping a wildcard or drifting listener.
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
    let hardened = source;

    if (!hardened.includes(LOOPBACK_HOSTNAME)) {
      if (!SERVE_WITHOUT_HOST_RE.test(hardened)) {
        throw new Error(
          `[electrobun-loopback] cannot prove or patch loopback binding in ${candidate}`,
        );
      }
      hardened = hardened.replace(
        SERVE_WITHOUT_HOST_RE,
        `$1$2${LOOPBACK_HOSTNAME}\n$2$3`,
      );
    }

    if (!hardened.includes(EXPLICIT_PORT_MARKER)) {
      if (!DEFAULT_PORT_RANGE_RE.test(hardened)) {
        throw new Error(
          `[electrobun-loopback] cannot prove or patch exclusive port binding in ${candidate}`,
        );
      }
      hardened = hardened.replace(
        DEFAULT_PORT_RANGE_RE,
        `$1const configuredPort = Number.parseInt(Bun.env.ELECTROBUN_RPC_PORT ?? "", 10);\n` +
          `$1const hasConfiguredPort =\n` +
          `$1\tNumber.isInteger(configuredPort) &&\n` +
          `$1\tconfiguredPort >= 1 &&\n` +
          `$1\tconfiguredPort <= 65535;\n` +
          `$1const startPort = hasConfiguredPort ? configuredPort : 50000;\n` +
          `$1// An explicit port is an ownership contract. Do not silently let a\n` +
          `$1// second native app drift onto the next port.\n` +
          `$1const endPort = hasConfiguredPort ? startPort : 65535;`,
      );
    }

    if (hardened === source) continue;
    fileSystem.writeFileSync(candidate, hardened);
    changed.push(candidate);
  }
  return changed;
}
