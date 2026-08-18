/**
 * Docker seccomp contract for hosted agents that run Eliza Code's bubblewrap
 * shell boundary.
 *
 * The checked-in profile starts from Moby's `seccomp/v0.2.1` default profile
 * (Apache 2.0), removes the legacy `socketcall` multiplexer so it cannot bypass
 * the profile's AF_ALG socket-family filter (CVE-2026-31431), and adds four
 * narrowly-scoped rules required by bubblewrap 0.11:
 *
 * - `clone` only when the call atomically creates both a user and mount
 *   namespace (other namespace bits may accompany those two);
 * - `unshare(CLONE_NEWUSER)` only, used to disable nested user namespaces;
 * - mount/pivot/umount and hostname setup. The kernel still requires
 *   capabilities in the newly-created user/UTS namespace for these calls.
 *
 * This does not grant a Docker capability. Hosted containers continue to run
 * with `--cap-drop=ALL` and `no-new-privileges`; the profile only stops Docker's
 * outer filter from pre-empting the kernel's namespace-aware checks.
 *
 * Upstream source (pinned):
 * https://github.com/moby/profiles/blob/seccomp/v0.2.1/seccomp/default.json
 */

import { dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "./docker-sandbox-utils";
import hostedAgentBwrapSeccomp from "./hosted-agent-bwrap-seccomp.json";
import { buildHostedAgentPolicyRootCmd } from "./hosted-agent-root-command";

export const HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH = "/etc/eliza/hosted-agent-bwrap-seccomp.json";

/** SHA-256 of the canonical compact JSON payload, including its final newline. */
export const HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_SHA256 =
  "197b2b1a47a5e10b7da0daae2e62d8ae672b6fbb9a7ec5e9df6edb8bb56f6b4d";

export const HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON = `${JSON.stringify(
  hostedAgentBwrapSeccomp,
)}\n`;

function assertSafeAbsoluteProfilePath(profilePath: string): void {
  if (!isAbsolute(profilePath) || profilePath === "/" || /[\r\n\0]/.test(profilePath)) {
    throw new Error("hosted-agent seccomp profile path must be a safe absolute file path");
  }
}

/**
 * Idempotently install the immutable profile on a Docker node.
 *
 * The control plane executes this with root SSH or passwordless sudo
 * immediately before `docker create`, which both self-heals old nodes and
 * makes a missing or corrupted profile fail closed. The temp file is
 * checksum-verified and then atomically renamed into place.
 */
export function buildEnsureHostedAgentSeccompProfileCmd(
  profilePath = HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_PATH,
): string {
  assertSafeAbsoluteProfilePath(profilePath);
  const profileDir = dirname(profilePath);
  const tempTemplate = join(profileDir, ".hosted-agent-bwrap-seccomp.tmp.XXXXXX");
  const encodedProfile = Buffer.from(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_JSON, "utf8").toString(
    "base64",
  );
  const installCommand = [
    `install -d -m 0755 ${shellQuote(profileDir)}`,
    `tmp_path=$(mktemp ${shellQuote(tempTemplate)})`,
    `trap 'unlink "$tmp_path" 2>/dev/null || true' EXIT HUP INT TERM`,
    `printf %s ${shellQuote(encodedProfile)} | base64 -d > "$tmp_path"`,
    `printf '%s  %s\\n' ${shellQuote(HOSTED_AGENT_BWRAP_SECCOMP_PROFILE_SHA256)} "$tmp_path" | sha256sum -c - >/dev/null`,
    `chmod 0644 "$tmp_path"`,
    `mv -f "$tmp_path" ${shellQuote(profilePath)}`,
    "trap - EXIT HUP INT TERM",
  ].join(" && ");
  return buildHostedAgentPolicyRootCmd(installCommand);
}
