/**
 * Represents a table for storing agent data.
 *
 * @type {Table}
 */
export declare const agentTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "agents";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "agents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: true;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    enabled: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "enabled";
        tableName: "agents";
        dataType: "boolean";
        columnType: "PgBoolean";
        data: boolean;
        driverParam: boolean;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    server_id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "server_id";
        tableName: "agents";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "agents";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    updatedAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "updated_at";
        tableName: "agents";
        dataType: "date";
        columnType: "PgTimestamp";
        data: Date;
        driverParam: string;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    name: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "name";
        tableName: "agents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: true;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    username: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "username";
        tableName: "agents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    system: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "system";
        tableName: "agents";
        dataType: "string";
        columnType: "PgText";
        data: string;
        driverParam: string;
        notNull: false;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {}
    >;
    bio: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "bio";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: string | string[];
        driverParam: unknown;
        notNull: false;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: string | string[];
      }
    >;
    messageExamples: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "message_examples";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: MessageExample[][];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: MessageExample[][];
      }
    >;
    postExamples: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "post_examples";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: string[];
      }
    >;
    topics: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "topics";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: string[];
      }
    >;
    adjectives: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "adjectives";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: string[];
      }
    >;
    knowledge: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "knowledge";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: (
          | string
          | {
              path: string;
              shared?: boolean;
            }
        )[];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: (
          | string
          | {
              path: string;
              shared?: boolean;
            }
        )[];
      }
    >;
    plugins: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "plugins";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: string[];
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: string[];
      }
    >;
    settings: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "settings";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: {
          [key: string]: unknown;
          secrets?: {
            [key: string]: string | boolean | number;
          };
        };
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: {
          [key: string]: unknown;
          secrets?: {
            [key: string]: string | boolean | number;
          };
        };
      }
    >;
    style: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "style";
        tableName: "agents";
        dataType: "json";
        columnType: "PgJsonb";
        data: {
          all?: string[];
          chat?: string[];
          post?: string[];
        };
        driverParam: unknown;
        notNull: true;
        hasDefault: true;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: undefined;
        baseColumn: never;
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        $type: {
          all?: string[];
          chat?: string[];
          post?: string[];
        };
      }
    >;
  };
  dialect: "pg";
}>;
//# sourceMappingURL=agent.d.ts.map
