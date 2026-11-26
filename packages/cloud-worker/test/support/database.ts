// spec/cloud/deployment.md, "An instance starts only for an accepted profile, on its environment's own readable database, seeded only in staging, with loopback delivery only on PGlite"
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export type DatabaseSetup = (db: PGlite) => Promise<unknown>;

export interface ServedDatabase {
  readonly url: string;
  close(): Promise<void>;
}

export async function serveDatabase(setup?: DatabaseSetup): Promise<ServedDatabase> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 10 });
  const close = async () => {
    try {
      await server.stop();
    } finally {
      await db.close();
    }
  };
  try {
    await setup?.(db);
    await server.start();
  } catch (cause) {
    await close();
    throw cause;
  }
  return { url: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`, close };
}
