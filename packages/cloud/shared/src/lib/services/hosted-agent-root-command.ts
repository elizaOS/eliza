import { shellQuote } from "./docker-sandbox-utils";

export const HOSTED_AGENT_POLICY_ROOT_REQUIREMENT =
  "hosted-agent policy installation requires root SSH or passwordless sudo root capability";
const HOSTED_AGENT_POLICY_SUDO_FAILURE =
  "hosted-agent policy installation through sudo failed; verify root capability and host policy tooling";

/**
 * Run a trusted generated policy installer as root on a managed Docker node.
 * Docker-group membership alone cannot install /etc policy or load AppArmor.
 */
export function buildHostedAgentPolicyRootCmd(command: string): string {
  if (!command || command.includes("\0")) {
    throw new Error("hosted-agent root command must be non-empty and contain no NUL bytes");
  }
  const quotedCommand = shellQuote(command);
  const quotedRequirement = shellQuote(HOSTED_AGENT_POLICY_ROOT_REQUIREMENT);
  const quotedSudoFailure = shellQuote(HOSTED_AGENT_POLICY_SUDO_FAILURE);
  return [
    'if [ "$(id -u)" -eq 0 ]',
    `then /bin/sh -c ${quotedCommand}`,
    "elif command -v sudo >/dev/null 2>&1",
    `then sudo -n /bin/sh -c ${quotedCommand} || { status=$?; printf '%s\\n' ${quotedSudoFailure} >&2; exit "$status"; }`,
    `else printf '%s\\n' ${quotedRequirement} >&2; exit 1`,
    "fi",
  ].join("; ");
}
