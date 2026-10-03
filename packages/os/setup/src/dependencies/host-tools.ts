/** Shared discovery for dependency checks and the processes that use installed tools. */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function findHostTool(
  name: string,
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const vendor = join(
    options.home ?? homedir(),
    ".elizaos/flasher/vendor/bin",
    platform,
  );
  const android = name === "adb" || name === "fastboot";
  const directories = [
    vendor,
    ...(android
      ? [
          join(vendor, "platform-tools"),
          ...[env.ANDROID_HOME, env.ANDROID_SDK_ROOT]
            .filter((root): root is string => Boolean(root))
            .map((root) => join(root, "platform-tools")),
        ]
      : []),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    ...(env.PATH ?? env.Path ?? "").split(
      platform === "win32" ? ";" : delimiter,
    ),
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = join(
      directory,
      platform === "win32" ? `${name}.exe` : name,
    );
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(
        candidate,
        platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw error;
      }
    }
  }
  return undefined;
}
