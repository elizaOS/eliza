let cachedPrefix: string | null = null;

type RuntimeProcess = {
  argv?: string[];
  cwd?: () => string;
  env?: Record<string, string | undefined>;
};

function getRuntimeProcess(): RuntimeProcess | undefined {
  const candidate = (globalThis as { process?: RuntimeProcess }).process;
  return candidate && typeof candidate === "object" ? candidate : undefined;
}

function prefixFromPackageName(name: string): string {
  let packageName = name;
  if (packageName.startsWith("@"))
    packageName = packageName.split("/")[1] ?? packageName;
  if (packageName === "elizaos" || packageName.includes("eliza")) {
    return "[eliza]";
  }
  return `[${packageName}]`;
}

export function getLogPrefix(): string {
  if (cachedPrefix !== null) {
    return cachedPrefix;
  }

  const runtimeProcess = getRuntimeProcess();

  const appCliName = runtimeProcess?.env?.APP_CLI_NAME?.trim();
  if (appCliName) {
    cachedPrefix = `[${appCliName}]`;
    return cachedPrefix;
  }

  const packageName = runtimeProcess?.env?.npm_package_name?.trim();
  if (packageName) {
    cachedPrefix = prefixFromPackageName(packageName);
    return cachedPrefix;
  }

  const nameArgMatch = runtimeProcess?.argv?.find((a) =>
    a.startsWith("--name="),
  );
  if (nameArgMatch) {
    const name = nameArgMatch.split("=")[1];
    cachedPrefix = `[${name}]`;
    return cachedPrefix;
  }

  const cwd =
    typeof runtimeProcess?.cwd === "function" ? runtimeProcess.cwd() : "";
  if (cwd.includes("eliza-workspace") || cwd.includes("eliza")) {
    cachedPrefix = "[eliza]";
    return cachedPrefix;
  }

  cachedPrefix = "[eliza]";
  return cachedPrefix;
}
