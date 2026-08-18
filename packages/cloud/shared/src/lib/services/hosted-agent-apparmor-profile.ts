/**
 * Checksum-pinned AppArmor policy for the hosted Eliza Code bubblewrap lane.
 * The policy's only authority delta from Moby's docker-default template is
 * allowing mount/pivot-root/umount past the LSM so the kernel can enforce
 * capabilities inside bwrap's fresh user namespace. It is never selected as
 * unconfined or complain mode.
 */

import { dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "./docker-sandbox-utils";
import { buildHostedAgentPolicyRootCmd } from "./hosted-agent-root-command";

export const HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME = "eliza-hosted-agent-bwrap";
export const HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_PATH = "/etc/apparmor.d/eliza-hosted-agent-bwrap";
export const HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_SHA256 =
  "c498d75415082ce5033cc1ac8bcaaa508b7b034118602abe60734820eb8333ea";

export const HOSTED_AGENT_BWRAP_APPARMOR_PROFILE = `# SPDX-FileCopyrightText: Copyright The Moby Authors
# SPDX-License-Identifier: Apache-2.0
#
# Derived from moby/profiles apparmor/template.go. The only authority increase
# relative to docker-default is mount/pivot-root/umount mediation: Docker still
# drops every capability, so the kernel permits those operations only after
# bubblewrap atomically creates its unprivileged user + mount namespaces. All
# docker-default proc/sysfs, AF_ALG, signal, and ptrace restrictions remain.

abi <abi/3.0>,
#include <tunables/global>

profile "eliza-hosted-agent-bwrap" flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  # Disallow AF_ALG (Linux kernel crypto API); see https://copy.fail/
  deny network alg,
  capability,
  file,
  mount,
  pivot_root,
  umount,
  # Host and OCI-runtime processes may stop/kill the container.
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  # Container processes may signal one another.
  signal (send,receive) peer="eliza-hosted-agent-bwrap",

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  # bubblewrap --disable-userns sets this one namespace-local sysctl to zero;
  # retain docker-default's write denial for every other current user sysctl.
  deny @{PROC}/sys/[^ku]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sys/user/max_{cgroup,ipc,mnt,net,pid,time,uts}_namespaces w,
  @{PROC}/sys/user/max_user_namespaces w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  ptrace (trace,tracedby,read,readby) peer="eliza-hosted-agent-bwrap",
}
`;

function assertSafeAbsoluteProfilePath(profilePath: string): void {
  if (!isAbsolute(profilePath) || profilePath === "/" || /[\r\n\0]/.test(profilePath)) {
    throw new Error("hosted-agent AppArmor profile path must be a safe absolute file path");
  }
}

/** Atomically installs, checksum-verifies, loads, and enforce-verifies the policy. */
export function buildEnsureHostedAgentAppArmorProfileCmd(
  profilePath = HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_PATH,
): string {
  assertSafeAbsoluteProfilePath(profilePath);
  const profileDir = dirname(profilePath);
  const tempTemplate = join(profileDir, ".eliza-hosted-agent-bwrap.tmp.XXXXXX");
  const encodedProfile = Buffer.from(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE, "utf8").toString(
    "base64",
  );
  const installCommand = [
    `command -v apparmor_parser >/dev/null 2>&1 || { printf '%s\\n' ${shellQuote("apparmor_parser is required for the hosted-agent AppArmor policy")} >&2; exit 1; }`,
    `install -d -m 0755 ${shellQuote(profileDir)}`,
    `tmp_path=$(mktemp ${shellQuote(tempTemplate)})`,
    `trap 'unlink "$tmp_path" 2>/dev/null || true' EXIT HUP INT TERM`,
    `printf %s ${shellQuote(encodedProfile)} | base64 -d > "$tmp_path"`,
    `printf '%s  %s\\n' ${shellQuote(HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_SHA256)} "$tmp_path" | sha256sum -c - >/dev/null`,
    `chmod 0644 "$tmp_path"`,
    `mv -f "$tmp_path" ${shellQuote(profilePath)}`,
    `trap - EXIT HUP INT TERM`,
    `apparmor_parser -Kr ${shellQuote(profilePath)}`,
    `grep -Fx ${shellQuote(`${HOSTED_AGENT_BWRAP_APPARMOR_PROFILE_NAME} (enforce)`)} /sys/kernel/security/apparmor/profiles >/dev/null`,
  ].join(" && ");
  return buildHostedAgentPolicyRootCmd(installCommand);
}
