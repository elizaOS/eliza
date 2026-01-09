/**
 * Defines the relationshipTable containing information about relationships between entities and agents.
 * @type {import('knex').TableBuilder}
 */
export declare const relationshipTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "relationships";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "relationships";
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
    createdAt: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "created_at";
        tableName: "relationships";
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
    sourceEntityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "source_entity_id";
        tableName: "relationships";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
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
    targetEntityId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "target_entity_id";
        tableName: "relationships";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
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
    agentId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "agent_id";
        tableName: "relationships";
        dataType: "string";
        columnType: "PgUUID";
        data: string;
        driverParam: string;
        notNull: true;
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
    tags: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "tags";
        tableName: "relationships";
        dataType: "array";
        columnType: "PgArray";
        data: string[];
        driverParam: string | string[];
        notNull: false;
        hasDefault: false;
        isPrimaryKey: false;
        isAutoincrement: false;
        hasRuntimeDefault: false;
        enumValues: [string, ...string[]];
        baseColumn: import("drizzle-orm").Column<
          {
            name: "tags";
            tableName: "relationships";
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
        identity: undefined;
        generated: undefined;
      },
      {},
      {
        size: undefined;
        baseBuilder: import("drizzle-orm/pg-core").PgColumnBuilder<
          {
            name: "tags";
            dataType: "string";
            columnType: "PgText";
            data: string;
            enumValues: [string, ...string[]];
            driverParam: string;
          },
          {},
          {},
          import("drizzle-orm").ColumnBuilderExtraConfig
        >;
      }
    >;
    metadata: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "metadata";
        tableName: "relationships";
        dataType: "json";
        columnType: "PgJsonb";
        data: unknown;
        driverParam: unknown;
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
  };
  dialect: "pg";
}>;
//# sourceMappingURL=relationship.d.ts.map
