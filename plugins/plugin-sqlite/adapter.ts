/** Provides the native Node/Bun SQLite adapter with shared transactional record behavior. */
import { SQLiteAdapterBase } from "./adapter-base";
import { nativeSQLiteDriver } from "./sqlite-driver";
export class SQLiteDatabaseAdapter extends SQLiteAdapterBase {
  protected static override driver = nativeSQLiteDriver;
}
