/**
 * Writes the pre-migrated PGlite snapshot for the mobile bundle
 * (`pglite-migrated.bin`; plugins/plugin-sql/src/pglite/migrated-snapshot.ts).
 *
 * It migrates the schemas every mobile boot migrates before readiness: the
 * core SQL schema, the required scheduling plugin and the agent's own `eliza`
 * plugin, under the names the runtime registers them with. A plugin loaded
 * later (or one whose schema changed since this build) still migrates at boot.
 *
 * build-mobile-bundle.ts runs it in a child process (PGlite keeps the event
 * loop alive), with PGLITE_INITDB_SNAPSHOT naming the initdb snapshot it just
 * made, so both snapshots come from the PGlite the bundle carries:
 *
 *   PGLITE_INITDB_SNAPSHOT=<dist>/pglite-initdb.bin \
 *     bun --conditions=eliza-source make-pglite-migrated-snapshot.ts <out>
 */
import path from "node:path";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import {
  createMigratedSnapshot,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import {
  ELIZA_PLUGIN_NAME,
  elizaPluginSchema,
} from "../src/runtime/eliza-plugin-schema.ts";

/** The plugin schemas a mobile boot migrates before readiness, in boot order. */
export function bootMigratedPluginSchemas() {
  if (!schedulingPlugin.schema || !sqlPlugin.schema) {
    throw new Error("plugin-scheduling and plugin-sql must declare a schema");
  }
  return [
    { name: schedulingPlugin.name, schema: schedulingPlugin.schema },
    { name: ELIZA_PLUGIN_NAME, schema: elizaPluginSchema },
    { name: sqlPlugin.name, schema: sqlPlugin.schema },
  ];
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out || !path.isAbsolute(out)) {
    console.error(
      "usage: make-pglite-migrated-snapshot.ts <absolute output path>",
    );
    process.exit(2);
  }
  const bytes = await createMigratedSnapshot(bootMigratedPluginSchemas());
  await Bun.write(out, bytes);
  process.exit(0);
}
