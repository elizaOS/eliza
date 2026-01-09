import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { IDatabaseClientManager } from "../types";
/**
 * Class representing a database client manager for PGlite.
 * @implements { IDatabaseClientManager }
 */
export declare class PGliteClientManager
  implements IDatabaseClientManager<PGlite>
{
  private client;
  private shuttingDown;
  /**
   * Constructor for creating a new instance of PGlite with the provided options.
   * Initializes the PGlite client with additional extensions.
   * @param {PGliteOptions} options - The options to configure the PGlite client.
   */
  constructor(options: PGliteOptions);
  getConnection(): PGlite;
  isShuttingDown(): boolean;
  initialize(): Promise<void>;
  close(): Promise<void>;
  private setupShutdownHandlers;
}
//# sourceMappingURL=manager.d.ts.map
