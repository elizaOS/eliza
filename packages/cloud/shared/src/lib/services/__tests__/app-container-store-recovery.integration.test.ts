/** Proves malformed-delete recovery selects only deleting rows owned by the queued organization in real Postgres SQL. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { findDeletingAppContainerRows } from "../app-container-store-queries";

const ORG_ONE = "00000000-0000-0000-0000-0000000000a1";
const ORG_TWO = "00000000-0000-0000-0000-0000000000a2";
const USER_ID = "00000000-0000-0000-0000-0000000000b1";
const DELETING_ID = "00000000-0000-0000-0000-0000000000c1";

let client: PGlite;
let database: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);

  await client.exec(`
    CREATE TABLE containers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      project_name text NOT NULL,
      image_tag text,
      port integer NOT NULL,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      environment_vars jsonb NOT NULL DEFAULT '{}',
      metadata jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL
    )
  `);
  await client.exec(`
    INSERT INTO containers
      (id, name, project_name, image_tag, port, organization_id, user_id, status)
    VALUES
      ('${DELETING_ID}', 'delete-me', 'app-1', 'image:1', 3000, '${ORG_ONE}', '${USER_ID}', 'deleting'),
      ('00000000-0000-0000-0000-0000000000c2', 'keep-running', 'app-2', 'image:2', 3000, '${ORG_ONE}', '${USER_ID}', 'running'),
      ('00000000-0000-0000-0000-0000000000c3', 'other-org', 'app-3', 'image:3', 3000, '${ORG_TWO}', '${USER_ID}', 'deleting')
  `);
});

afterAll(async () => {
  await client.close();
});

describe("ContainerRepoAppContainerStore malformed-delete recovery", () => {
  test("filters by both organization ownership and deleting status", async () => {
    const rows = await findDeletingAppContainerRows(database, ORG_ONE);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: DELETING_ID,
      organization_id: ORG_ONE,
      name: "delete-me",
    });
  });
});
