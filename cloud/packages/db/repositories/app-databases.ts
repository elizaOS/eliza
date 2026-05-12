import { eq, inArray, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type AppDatabase, appDatabases, type NewAppDatabase } from "../schemas/app-databases";
import type { UserDatabaseStatus } from "../schemas/apps";

export type { AppDatabase, NewAppDatabase };

type DatabaseStateColumns = Pick<
  AppDatabase,
  | "app_id"
  | "user_database_uri"
  | "user_database_project_id"
  | "user_database_branch_id"
  | "user_database_region"
  | "user_database_status"
  | "user_database_error"
>;

export type AppDatabaseState = DatabaseStateColumns & {
  source: "app_databases";
};

type AppDatabaseStateUpdate = Partial<
  Pick<
    NewAppDatabase,
    | "user_database_uri"
    | "user_database_project_id"
    | "user_database_branch_id"
    | "user_database_region"
    | "user_database_status"
    | "user_database_error"
  >
>;

function compactUpdate(data: AppDatabaseStateUpdate): AppDatabaseStateUpdate {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as AppDatabaseStateUpdate;
}

/**
 * Repository for canonical app database provisioning state.
 *
 * Active reads and writes use `app_databases`; legacy `apps.user_database_*`
 * columns are retired by the consolidation migration.
 */
export class AppDatabasesRepository {
  async findByAppId(appId: string): Promise<AppDatabase | undefined> {
    return await dbRead.query.appDatabases.findFirst({
      where: eq(appDatabases.app_id, appId),
    });
  }

  async findStateByAppId(appId: string): Promise<AppDatabaseState | undefined> {
    return this.findStateByAppIdUsingDb(dbRead, appId);
  }

  async findStateByAppIdForWrite(appId: string): Promise<AppDatabaseState | undefined> {
    return this.findStateByAppIdUsingDb(dbWrite, appId);
  }

  async listStatesByAppIds(appIds: string[]): Promise<Map<string, AppDatabaseState>> {
    if (appIds.length === 0) {
      return new Map();
    }

    const rows = await dbRead.query.appDatabases.findMany({
      where: inArray(appDatabases.app_id, appIds),
    });

    return new Map(rows.map((row) => [row.app_id, this.toState(row)]));
  }

  async trySetProvisioning(appId: string, region: string): Promise<AppDatabase | undefined> {
    const [database] = await sqlRows<AppDatabase>(
      dbWrite,
      sql`
        INSERT INTO ${appDatabases} (
          app_id,
          user_database_status,
          user_database_error,
          user_database_region,
          updated_at
        )
        VALUES (${appId}, 'provisioning', NULL, ${region}, NOW())
        ON CONFLICT (app_id) DO UPDATE
        SET
          user_database_status = 'provisioning',
          user_database_error = NULL,
          user_database_region = EXCLUDED.user_database_region,
          updated_at = NOW()
        WHERE ${appDatabases.user_database_status} IN ('none', 'error')
        RETURNING *
      `,
    );

    return database;
  }

  async updateState(appId: string, data: AppDatabaseStateUpdate): Promise<AppDatabase> {
    const update = compactUpdate(data);
    const now = new Date();
    const [database] = await dbWrite
      .insert(appDatabases)
      .values({
        app_id: appId,
        ...update,
        updated_at: now,
      } as NewAppDatabase)
      .onConflictDoUpdate({
        target: appDatabases.app_id,
        set: {
          ...update,
          updated_at: now,
        },
      })
      .returning();

    return database;
  }

  private async findStateByAppIdUsingDb(
    database: typeof dbRead,
    appId: string,
  ): Promise<AppDatabaseState | undefined> {
    const canonical = await database.query.appDatabases.findFirst({
      where: eq(appDatabases.app_id, appId),
    });

    if (canonical) {
      return this.toState(canonical);
    }

    return undefined;
  }

  private toState(database: AppDatabase): AppDatabaseState {
    return {
      app_id: database.app_id,
      user_database_uri: database.user_database_uri,
      user_database_project_id: database.user_database_project_id,
      user_database_branch_id: database.user_database_branch_id,
      user_database_region: database.user_database_region,
      user_database_status: database.user_database_status as UserDatabaseStatus,
      user_database_error: database.user_database_error,
      source: "app_databases",
    };
  }
}

export const appDatabasesRepository = new AppDatabasesRepository();
