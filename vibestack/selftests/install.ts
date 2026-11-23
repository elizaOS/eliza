export function isolatedInstalls() {
  for (const name of Object.keys(process.env)) if (name.toLowerCase().replaceAll("-", "_") === "npm_config_package_import_method") delete process.env[name];
  process.env.npm_config_package_import_method = "clone-or-copy";
}

export function hostedCachedFixture(): boolean {
  const { GITHUB_ACTIONS, GITHUB_JOB, GITHUB_WORKSPACE, GITHUB_WORKFLOW_REF, GITHUB_REPOSITORY } = process.env;
  return GITHUB_ACTIONS === "true" && GITHUB_JOB === "vibestack-fixture-selftests" && GITHUB_WORKSPACE === process.cwd()
    && GITHUB_WORKFLOW_REF?.startsWith(`${GITHUB_REPOSITORY}/.github/workflows/ci.yml@`) === true;
}

export async function installChromium(fullOnly: boolean) {
  const { exec } = await import("../run.ts");
  const run = async (command: string, ...args: string[]) => {
    const result = await exec(command, args, process.cwd());
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.stopped || result.status !== 0) throw new Error(result.stopped ?? `${command} ${args.join(" ")} exited ${result.status}`);
  };
  await run("pnpm", "exec", "playwright", "install", "chromium", ...(fullOnly ? ["--no-shell"] : []));
  const probe = () => run(process.execPath, "--input-type=module", "-e", `
    import { chromium } from "playwright";
    async function check(options) {
      const browser = await chromium.launch({ timeout: 10_000, ...options });
      await browser.close();
    }
    await check({ executablePath: chromium.executablePath() });
    if (process.argv[1] !== "true") await check({});
  `, String(fullOnly));
  try { await probe(); }
  catch {
    await run("pnpm", "exec", "playwright", "install-deps", "chromium");
    await probe();
  }
}
