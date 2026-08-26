/**
 * Exposes the Node runtime raw-SQL capability boundary as a narrow public leaf
 * so repositories do not load the full framework entrypoint.
 */
export * from "./database/raw-sql.js";
