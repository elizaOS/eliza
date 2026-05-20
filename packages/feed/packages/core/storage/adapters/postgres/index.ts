/**
 * PostgreSQL Storage Adapter
 *
 * Wraps @babylon/db to implement the IStorageProvider interface.
 * This allows production code to use the same abstraction as simulation.
 */

export { PostgresStorageProvider } from './postgres-storage-provider';
