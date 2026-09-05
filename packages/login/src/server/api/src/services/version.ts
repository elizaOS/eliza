/**
 * Steward API version without importing the heavyweight request context graph.
 *
 * Keep this in a dependency-light module: audit signing is also imported by
 * maintenance scripts and package tests that do not build API runtime
 * dependencies such as @stwd/redis.
 */
export const API_VERSION = process.env.API_VERSION || "0.3.0";
