import { VECTOR_DIMS } from "@elizaos/core";
export declare const DIMENSION_MAP: {
  readonly [VECTOR_DIMS.SMALL]: "dim384";
  readonly [VECTOR_DIMS.MEDIUM]: "dim512";
  readonly [VECTOR_DIMS.LARGE]: "dim768";
  readonly [VECTOR_DIMS.XL]: "dim1024";
  readonly [VECTOR_DIMS.XXL]: "dim1536";
  readonly [VECTOR_DIMS.XXXL]: "dim3072";
};
/**
 * Definition of the embeddings table in the database.
 * Contains columns for ID, Memory ID, Creation Timestamp, and multiple vector dimensions.
 */
export declare const embeddingTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
  name: "embeddings";
  schema: undefined;
  columns: {
    id: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "id";
        tableName: "embeddings";
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
    memoryId: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "memory_id";
        tableName: "embeddings";
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
        tableName: "embeddings";
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
    dim384: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_384";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
    dim512: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_512";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
    dim768: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_768";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
    dim1024: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_1024";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
    dim1536: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_1536";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
    dim3072: import("drizzle-orm/pg-core").PgColumn<
      {
        name: "dim_3072";
        tableName: "embeddings";
        dataType: "array";
        columnType: "PgVector";
        data: number[];
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
      {
        dimensions: any;
      }
    >;
  };
  dialect: "pg";
}>;
/**
 * Defines the possible values for the Embedding Dimension Column.
 * It can be "dim384", "dim512", "dim768", "dim1024", "dim1536", or "dim3072".
 */
export type EmbeddingDimensionColumn =
  | "dim384"
  | "dim512"
  | "dim768"
  | "dim1024"
  | "dim1536"
  | "dim3072";
/**
 * Retrieve the type of a specific column in the EmbeddingTable based on the EmbeddingDimensionColumn key.
 */
export type EmbeddingTableColumn =
  (typeof embeddingTable._.columns)[EmbeddingDimensionColumn];
//# sourceMappingURL=embedding.d.ts.map
