/** Builds the ACP first-turn coding contract from the tools the Pi profile actually exposes. */

/** Returns the non-interactive execution instructions injected before an ACP task. */
export function buildAcpCodingPreamble(workspace?: string): string[] {
  const preamble = [
    'Execution contract: DO the work by calling tools. Use READ to inspect files, WRITE to create or intentionally replace complete files, EDIT for exact localized changes, and SHELL to run commands and verification. Do NOT reply with a description of what you are about to do; a turn that only says "I\'ll create..." or "Creating the app now" without an accompanying WRITE, EDIT, or SHELL tool call is a failure. For a multi-file or large build, perform each mutation with WRITE or EDIT, verify it, and only then report what you did. Never claim a file exists unless you wrote it this session.',
  ];
  if (workspace) {
    preamble.push(
      `Your workspace directory is: ${workspace}\nAll file paths MUST be absolute — create and edit files under this directory (e.g. ${workspace}/<filename>) and run shell commands from here.`,
    );
  }
  return preamble;
}
