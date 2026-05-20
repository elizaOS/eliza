/**
 * Database Types
 *
 * Core types for database operations including JSON values, decimals, errors, and query inputs.
 */

/**
 * JSON value type representing all valid JSON values.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type InputJsonValue = JsonValue;

/**
 * Decimal number class for precise decimal arithmetic.
 * Uses string representation for database storage to avoid floating-point precision issues.
 */
export class Decimal {
  private value: string;

  constructor(value: string | number | Decimal) {
    if (value instanceof Decimal) {
      this.value = value.toString();
    } else if (typeof value === "number") {
      this.value = value.toString();
    } else {
      this.value = value;
    }
  }

  toString(): string {
    return this.value;
  }

  toNumber(): number {
    return Number.parseFloat(this.value);
  }

  static add(
    a: Decimal | string | number,
    b: Decimal | string | number,
  ): Decimal {
    const aNum = typeof a === "number" ? a : Number.parseFloat(a.toString());
    const bNum = typeof b === "number" ? b : Number.parseFloat(b.toString());
    return new Decimal((aNum + bNum).toString());
  }

  static sub(
    a: Decimal | string | number,
    b: Decimal | string | number,
  ): Decimal {
    const aNum = typeof a === "number" ? a : Number.parseFloat(a.toString());
    const bNum = typeof b === "number" ? b : Number.parseFloat(b.toString());
    return new Decimal((aNum - bNum).toString());
  }

  static mul(
    a: Decimal | string | number,
    b: Decimal | string | number,
  ): Decimal {
    const aNum = typeof a === "number" ? a : Number.parseFloat(a.toString());
    const bNum = typeof b === "number" ? b : Number.parseFloat(b.toString());
    return new Decimal((aNum * bNum).toString());
  }

  static div(
    a: Decimal | string | number,
    b: Decimal | string | number,
  ): Decimal {
    const aNum = typeof a === "number" ? a : Number.parseFloat(a.toString());
    const bNum = typeof b === "number" ? b : Number.parseFloat(b.toString());
    return new Decimal((aNum / bNum).toString());
  }
}

/**
 * PostgreSQL database error codes.
 */
export const DbErrorCodes = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  NOT_NULL_VIOLATION: "23502",
  CHECK_VIOLATION: "23514",
} as const;

/**
 * Database error class with error code support.
 */
export class DatabaseError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/**
 * Union type representing all possible database error types.
 */
export type DatabaseErrorType =
  | DatabaseError
  | Error
  | { code?: string; message?: string; name?: string };

/**
 * Convert an unknown error to DatabaseErrorType.
 *
 * @param error - Error to convert
 * @returns DatabaseErrorType instance
 */
export function toDatabaseErrorType(error: unknown): DatabaseErrorType {
  if (error instanceof DatabaseError || error instanceof Error) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    return error as DatabaseErrorType;
  }
  return new Error(String(error));
}

/**
 * Check if an error is a unique constraint violation.
 *
 * @param error - Error to check
 * @returns True if the error is a unique constraint violation
 */
export function isUniqueConstraintError(error: DatabaseErrorType): boolean {
  if (error instanceof DatabaseError) {
    return error.code === DbErrorCodes.UNIQUE_VIOLATION;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const pgError = error as { code?: string };
    return pgError.code === DbErrorCodes.UNIQUE_VIOLATION;
  }
  return false;
}

/**
 * Where input type for filtering queries with support for AND, OR, and NOT operators.
 */
export type WhereInput<T> = Partial<{
  [K in keyof T]:
    | T[K]
    | {
        equals?: T[K];
        not?: T[K];
        in?: T[K][];
        notIn?: T[K][];
        lt?: T[K];
        lte?: T[K];
        gt?: T[K];
        gte?: T[K];
        contains?: string;
        startsWith?: string;
        endsWith?: string;
      };
}> & {
  AND?: WhereInput<T> | WhereInput<T>[];
  OR?: WhereInput<T>[];
  NOT?: WhereInput<T> | WhereInput<T>[];
};

/**
 * Order by input type for sorting query results.
 */
export type OrderByInput<T> = Partial<{
  [K in keyof T]: "asc" | "desc";
}>;

/**
 * Select input type for specifying which fields to return.
 */
export type SelectInput<T> = Partial<{
  [K in keyof T]: boolean;
}>;

/**
 * Include input type for loading relations in queries.
 */
export type IncludeInput = Record<
  string,
  boolean | { select?: Record<string, boolean>; include?: IncludeInput }
>;
