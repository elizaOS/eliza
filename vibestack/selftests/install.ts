export function isolatedInstalls() {
  for (const name of Object.keys(process.env)) if (name.toLowerCase().replaceAll("-", "_") === "npm_config_package_import_method") delete process.env[name];
  process.env.npm_config_package_import_method = "clone-or-copy";
}
