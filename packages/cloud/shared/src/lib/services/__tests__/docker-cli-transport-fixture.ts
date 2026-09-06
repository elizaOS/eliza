/**
 * Exposes the Docker operation to stateful transport fixtures that do not run
 * a shell. Real-shell daemon-authority tests own the isolation wrapper itself.
 */
export function unwrapIsolatedDockerCommandForFixture(command: string): string {
  const prefix = "set -eu; umask 077; exact_docker_config=";
  const operationStart = command.indexOf("; (");
  return command.startsWith(prefix) && operationStart >= 0 && command.endsWith(")")
    ? command.slice(operationStart + 3, -1)
    : command;
}
