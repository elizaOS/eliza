# SQL Plugin - Integration Tests

This directory contains integration tests for the `@elizaos/plugin-sql` package. These tests interact with a PGlite (PostgreSQL-compatible SQLite) database instance to ensure the database adapter functions correctly.

## Setup

The integration tests now use **PGlite** by default, which runs a PostgreSQL-compatible environment using SQLite. This simplifies the setup process as a separate PostgreSQL database instance is **no longer required** for running these tests.

When the tests are executed:

- PGlite initializes the database schema.
- Database files for PGlite may be created in an `.pglite` directory at the root of the `packages/plugin-sql` package. This allows for inspection if needed but is generally handled automatically.

The previous dependency on `seed/config.ts` and the `TEST_DATABASE_URL` environment variable for configuring a PostgreSQL connection has been removed for the default PGlite setup.

### Database Schema and Migrations

**Important:** The `PgliteDatabaseAdapter` used in testing is responsible for initializing the database schema required for the tests. The `setupMockedMigrations()` helper function, present in the test files, indicates that the standard migration process (e.g., `runMigrations` designed for a persistent PostgreSQL database) is adapted or bypassed for the PGlite test environment.

The schema defined in `packages/plugin-sql/src/schema/` is used to set up the PGlite instance.

While you no longer need to manually migrate a separate test PostgreSQL database, the Drizzle Kit migration command is still essential for **managing and generating the SQL schema files**:

```bash
npx drizzle-kit migrate --config=packages/plugin-sql/drizzle.config.ts
```

This command should be run from the **root of the monorepo** whenever you make changes to the database schema defined with Drizzle ORM. It updates the migration files in `packages/plugin-sql/drizzle/migrations`, which are the source of truth for the database structure.

## Seed Data

The `seed/` directory contains data used to populate the database for various test scenarios (e.g., agents, entities, rooms). Each test file typically imports seed data relevant to its specific focus. This data is inserted into the PGlite instance during test execution.

## Running Tests

Tests are run using `vitest` via `bun` scripts defined in the `package.json`.

### Running All Integration Tests

To run all tests within this integration directory:

```bash
bun run test:integration
```

This command executes the `test:integration` script, which specifically targets the `__tests__/integration` path.

### Running a Single Test File

When developing or debugging, you might want to run only a specific test file. Use the following command, replacing `<path_to_test_file>` with the relative path to the file (e.g., `__tests__/integration/memory.test.ts`):

```bash
bun run test -- <path_to_test_file>
```

**Example:**

```bash
bun run test -- __tests__/integration/memory.test.ts
```

The `--` separates the `bun run` command from the arguments passed directly to `vitest`.
