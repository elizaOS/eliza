import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDb } from "./client";

declare const process: {
  argv: string[];
  exitCode?: number;
};

export async function runMigrations() {
  const { client, db } = createDb();

  try {
    await migrate(db, {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
  } finally {
    await client.end();
  }
}

const isEntrypoint = process.argv[1] === new URL(import.meta.url).pathname;

if (isEntrypoint) {
  runMigrations().catch((error) => {
    console.error("Failed to run migrations", error);
    process.exitCode = 1;
  });
}
