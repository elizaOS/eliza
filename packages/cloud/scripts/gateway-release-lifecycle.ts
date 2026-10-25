/** Preserve staging's existing declarative lifecycle; production stays legacy. */
export function gatewayReleaseLifecycle(
  config: Record<string, unknown>,
  environment: "staging" | "production",
): Record<string, unknown> {
  if (environment === "production") return config;
  if (
    "exports" in config ||
    !Array.isArray(config.migrations) ||
    !config.migrations.length
  )
    throw new Error(
      "Staging gateway requires additive SQLite migration history",
    );
  const exports: Record<string, { type: "durable-object"; storage: "sqlite" }> =
    {};
  const tags = new Set<string>();
  for (const migration of config.migrations) {
    if (
      !migration ||
      typeof migration !== "object" ||
      Array.isArray(migration) ||
      Object.keys(migration).some(
        (key) => key !== "tag" && key !== "new_sqlite_classes",
      ) ||
      typeof migration.tag !== "string" ||
      !migration.tag.trim() ||
      tags.has(migration.tag) ||
      !Array.isArray(migration.new_sqlite_classes) ||
      !migration.new_sqlite_classes.length
    )
      throw new Error("Unsupported staging gateway migration history");
    tags.add(migration.tag);
    for (const name of migration.new_sqlite_classes) {
      if (
        typeof name !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ||
        Object.hasOwn(exports, name)
      )
        throw new Error("Invalid or duplicate staging gateway class");
      Object.defineProperty(exports, name, {
        value: { type: "durable-object", storage: "sqlite" },
        enumerable: true,
      });
    }
  }
  if (!Object.hasOwn(exports, "GatewayContainer"))
    throw new Error("Staging gateway lifecycle must retain GatewayContainer");
  const { migrations: _migrations, ...declarative } = config;
  return { ...declarative, exports };
}
