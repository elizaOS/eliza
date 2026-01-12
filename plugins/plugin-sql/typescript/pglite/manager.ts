import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { vector } from "@electric-sql/pglite/vector";
import type { IDatabaseClientManager } from "../types";

export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  private client: PGlite;
  private shuttingDown = false;

  constructor(options: PGliteOptions) {
    this.client = new PGlite({
      ...options,
      extensions: {
        vector,
        fuzzystrmatch,
      },
    });
    this.setupShutdownHandlers();
  }

  public getConnection(): PGlite {
    return this.client;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async initialize(): Promise<void> {}

  public async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
  }

  private setupShutdownHandlers() {}
}
