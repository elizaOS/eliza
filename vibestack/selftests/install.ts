import { hostedCiWorkspace } from "../chromium.ts";

export function isolatedInstalls() {
  for (const name of Object.keys(process.env)) if (name.toLowerCase().replaceAll("-", "_") === "npm_config_package_import_method") delete process.env[name];
  process.env.npm_config_package_import_method = "clone-or-copy";
}

export function hostedCachedFixture(): boolean {
  return process.env.GITHUB_JOB === "vibestack-fixture-selftests" && hostedCiWorkspace() === process.cwd();
}
