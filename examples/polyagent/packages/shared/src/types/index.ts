/**
 * Shared Type Exports
 *
 * Re-exports all shared types for easy importing
 */

// Agent types
export * from "./agents";
// Auth types
export * from "./auth";
// Common types (JsonValue, etc.)
export * from "./common";
// Error types (interfaces and type guards)
// Error classes are exported from ./errors/index.ts
export type { AppError, NetworkError } from "./errors";
export {
  extractErrorMessage,
  isAuthenticationError,
  isDatabaseError,
  isLLMError,
  isNetworkError,
  isValidationError,
} from "./errors";
// Group types (tiers, alpha levels)
export * from "./groups";
// Social interaction types
export * from "./interactions";
// Agent monitoring types
export * from "./monitoring";
// Payment types
export * from "./payments";
// Profile widget types (balance, positions, etc.)
export * from "./profile";
// Profile types (user/actor profiles)
export * from "./profiles";
