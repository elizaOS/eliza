/** Hardens packaged Electrobun renderer RPC listeners and exclusive port leases. */

import fs from "node:fs";
import path from "node:path";

const SOCKET_SOURCE = path.join("api", "bun", "core", "Socket.ts");
const LOOPBACK_HOSTNAME = 'hostname: "127.0.0.1",';
const RENDERER_RPC_PORT_ENV = "ELIZA_ELECTROBUN_RENDERER_RPC_PORT";
const EXPLICIT_PORT_MARKER = `Bun.env.${RENDERER_RPC_PORT_ENV}`;
const LEGACY_EXPLICIT_PORT_MARKER = "Bun.env.ELECTROBUN_RPC_PORT";
const SERVE_WITHOUT_HOST_RE =
  /(server\s*=\s*Bun\.serve<[^>]+>\(\{\r?\n)([\t ]+)(port,)/;
const DEFAULT_PORT_RANGE_RE =
  /([\t ]*)const startPort = 50000;\r?\n\1const endPort = 65535;/;
const LEGACY_PORT_RANGE_RE =
  /([\t ]*)const configuredPort = Number\.parseInt\(Bun\.env\.ELECTROBUN_RPC_PORT \?\? "", 10\);\r?\n\1const hasConfiguredPort =\r?\n\1\tNumber\.isInteger\(configuredPort\) &&\r?\n\1\tconfiguredPort >= 1 &&\r?\n\1\tconfiguredPort <= 65535;\r?\n\1const startPort = hasConfiguredPort \? configuredPort : 50000;\r?\n\1\/\/ An explicit port is an ownership contract\. Do not silently let a\r?\n\1\/\/ second native app drift onto the next port\.\r?\n\1const endPort = hasConfiguredPort \? startPort : 65535;/;
const RPC_RETURN_RE = /([\t ]*)return \{ rpcServer: server, rpcPort: port \};/;

function explicitPortRange(indent) {
  return (
    `${indent}const configuredPort = Number.parseInt(` +
    `Bun.env.${RENDERER_RPC_PORT_ENV} ?? "", 10);\n` +
    `${indent}const hasConfiguredPort =\n` +
    `${indent}\tNumber.isInteger(configuredPort) &&\n` +
    `${indent}\tconfiguredPort >= 1 &&\n` +
    `${indent}\tconfiguredPort <= 65535;\n` +
    `${indent}const startPort = hasConfiguredPort ? configuredPort : 50000;\n` +
    `${indent}// An explicit renderer port is an ownership contract. Do not\n` +
    `${indent}// silently drift onto the next port after a collision.\n` +
    `${indent}const endPort = hasConfiguredPort ? startPort : 65535;`
  );
}

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
 * any platform core downloaded by the CLI so the host is loopback-only and a
 * renderer-specific explicit port is an exclusive ownership contract.
 *
 * Do not reuse Electrobun's ELECTROBUN_RPC_PORT here: its native launcher also
 * consumes that variable, so the renderer server races the launcher for the
 * same port and BrowserWindow creation hangs. A changed upstream shape fails
 * closed instead of shipping a wildcard or a null renderer RPC server.
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

    if (hardened.includes(LEGACY_EXPLICIT_PORT_MARKER)) {
      if (!LEGACY_PORT_RANGE_RE.test(hardened)) {
        throw new Error(
          `[electrobun-loopback] cannot prove or migrate legacy renderer port binding in ${candidate}`,
        );
      }
      hardened = hardened.replace(LEGACY_PORT_RANGE_RE, (_match, indent) =>
        explicitPortRange(indent),
      );
    } else if (!hardened.includes(EXPLICIT_PORT_MARKER)) {
      if (!DEFAULT_PORT_RANGE_RE.test(hardened)) {
        throw new Error(
          `[electrobun-loopback] cannot prove or patch exclusive renderer port binding in ${candidate}`,
        );
      }
      hardened = hardened.replace(DEFAULT_PORT_RANGE_RE, (_match, indent) =>
        explicitPortRange(indent),
      );
    }

    if (!hardened.includes("configured renderer RPC port")) {
      if (!RPC_RETURN_RE.test(hardened)) {
        throw new Error(
          `[electrobun-loopback] cannot prove or patch renderer RPC startup failure in ${candidate}`,
        );
      }
      hardened = hardened.replace(
        RPC_RETURN_RE,
        `$1if (hasConfiguredPort && server === null) {\n` +
          `$1\tthrow new Error(\n` +
          `$1\t\t\`[electrobun-renderer-rpc] configured renderer RPC port \${configuredPort} is unavailable\`,\n` +
          `$1\t);\n` +
          `$1}\n\n$1return { rpcServer: server, rpcPort: port };`,
      );
    }

    if (hardened === source) continue;
    fileSystem.writeFileSync(candidate, hardened);
    changed.push(candidate);
  }
  return changed;
}
