/** Verifies transactional auth storage rejects HTTP-only drivers before publishing a one-time credential. */
import { afterEach, expect, test } from "bun:test";
import { PostgresBackend } from "../auth/src/store-backends";
import { closeDb } from "../db/src/client";

const previousDriver = process.env.DATABASE_DRIVER;
const previousUrl = process.env.DATABASE_URL;

afterEach(async () => {
  await closeDb();
  if (previousDriver === undefined) delete process.env.DATABASE_DRIVER;
  else process.env.DATABASE_DRIVER = previousDriver;
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
});

test("rejects Neon HTTP as an atomic authentication store", async () => {
  process.env.DATABASE_DRIVER = "neon-http";
  process.env.DATABASE_URL =
    "postgresql://test@db.example.test/login?sslmode=require";
  const backend = new PostgresBackend("login-driver-contract");
  await expect(
    backend.publish([
      {
        key: "challenge",
        value: "one-time-credential",
        expiresAt: Date.now() + 60_000,
      },
    ]),
  ).rejects.toMatchObject({ code: "LOGIN_RAW_SQL_DRIVER_UNSUPPORTED" });
});
