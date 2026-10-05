/** Provides isolated SQLite databases in Workers using the portable SQLite engine. */
import { SQLiteAdapterBase } from "./adapter-base";
import { portableSQLiteDriver } from "./portable-driver";
export class SQLiteDatabaseAdapter extends SQLiteAdapterBase {
  protected static override driver = portableSQLiteDriver;
}
