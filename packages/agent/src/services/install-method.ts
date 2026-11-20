/** npm's Windows launcher is a `.cmd` shim in the configured npm prefix. */
export function isWindowsNpmGlobalShim(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  return /(?:^|\/)npm\/eliza\.cmd$/i.test(executablePath.replace(/\\/g, "/"));
}
