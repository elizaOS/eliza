/**
 * TEST-ONLY re-export of drizzle-kit's `pushSchema` for PGlite-backed suites.
 *
 * `drizzle-kit` is a devDependency of @elizaos/cloud-shared, so a test that
 * lives in another package (e.g. cloud-api's route integration tests) cannot
 * resolve `drizzle-kit/api` from its own directory. Importing it through this
 * module resolves from cloud-shared instead. Never import this from runtime
 * code — drizzle-kit is not installed for production consumers.
 */

export { pushSchema } from "drizzle-kit/api";
