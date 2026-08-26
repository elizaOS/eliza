/**
 * Builds the fail-closed Linux launcher boundary for stability scenario code.
 * The trusted attempt controller retains provider credentials and owns proxies;
 * only explicit loopback ports and a credential-minimal environment cross in.
 */

import path from "node:path";

const credentialName =
  /(?:^|_)(?:AUTH|AUTHORIZATION|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u;

export function linuxSandboxUid(mode: string): string | undefined {
  const uid = process.env.ELIZA_STABILITY_LINUX_SANDBOX_UID;
  if (process.platform === "linux" && mode === "real-llm" && !uid) {
    throw new Error(
      "real-model stability on Linux requires ELIZA_STABILITY_LINUX_SANDBOX_UID",
    );
  }
  if (uid && !/^[1-9][0-9]*$/u.test(uid)) {
    throw new Error("ELIZA_STABILITY_LINUX_SANDBOX_UID must be a non-root UID");
  }
  return uid;
}

export function scenarioChildEnvironment(
  source: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || credentialName.test(name)) continue;
    environment[name] = value;
  }
  Object.assign(environment, additions);
  return environment;
}

export function loopbackPorts(urls: string[]): string {
  const ports = new Set<number>();
  for (const raw of urls) {
    const url = new URL(raw);
    if (url.hostname !== "127.0.0.1") {
      throw new Error(`sandbox endpoint is not IPv4 loopback: ${url.origin}`);
    }
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `sandbox endpoint has no explicit valid port: ${url.origin}`,
      );
    }
    ports.add(port);
  }
  if (ports.size === 0 || ports.size > 15) {
    throw new Error("sandbox requires between one and fifteen explicit ports");
  }
  return [...ports].sort((left, right) => left - right).join(",");
}

export function sandboxCommand(options: {
  uid: string | undefined;
  allowedPorts: string;
  repoRoot: string;
  outputDir: string;
  runtime: string;
  args: string[];
}): { command: string; args: string[] } {
  if (!options.uid) return { command: options.runtime, args: options.args };
  return {
    command: "sudo",
    args: [
      "-n",
      "--preserve-env",
      path.join(
        options.repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      ),
      "run",
      options.uid,
      options.allowedPorts,
      options.repoRoot,
      options.outputDir,
      options.runtime,
      ...options.args,
    ],
  };
}
