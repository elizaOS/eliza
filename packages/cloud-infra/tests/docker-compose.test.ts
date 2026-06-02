/**
 * Static coverage for local object-storage Docker Compose.
 *
 * The compose file is the offline S3-compatible storage path used by cloud
 * contributors. These tests catch drift between required env placeholders,
 * .env.example, ports, healthchecks, volumes, and service dependencies before
 * a developer discovers it during `docker compose up`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const CLOUD_DIR = join(import.meta.dir, "..", "cloud");
const STORAGE_DB_USER_INTERPOLATION = "${" + "STORAGE_DB_USER}";

type ComposeService = {
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  healthcheck?: {
    interval?: string;
    retries?: number;
    test?: string[];
    timeout?: string;
  };
  image?: string;
  ports?: string[];
  volumes?: string[];
};

type ComposeFile = {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};

function readCloudFile(file: string): string {
  return readFileSync(join(CLOUD_DIR, file), "utf-8");
}

function loadCompose(): ComposeFile {
  return parseYaml(readCloudFile("docker-compose.yml")) as ComposeFile;
}

function loadEnvExampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of readCloudFile(".env.example").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function requiredEnvVars(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\$\{([A-Z0-9_]+):\?/g)) {
        out.add(match[1]);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return [...out].sort();
}

describe("docker-compose.yml local object storage", () => {
  const compose = loadCompose();

  test("declares the storage database and storage API services", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "storage",
      "storage_db",
    ]);
    expect(compose.services.storage_db?.image).toBe("postgres:18-alpine");
    expect(compose.services.storage?.image).toBe(
      "supabase/storage-api:v1.58.4",
    );
  });

  test("keeps all required compose env placeholders documented in .env.example", () => {
    const required = requiredEnvVars(compose);
    expect(required).toEqual([
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_ANON_KEY",
      "STORAGE_AUTH_JWT_SECRET",
      "STORAGE_DB_PASSWORD",
      "STORAGE_DB_USER",
      "STORAGE_PGRST_JWT_SECRET",
      "STORAGE_SECRET_ACCESS_KEY",
      "STORAGE_SERVICE_KEY",
    ]);

    const exampleKeys = loadEnvExampleKeys();
    for (const key of required) {
      expect(
        exampleKeys.has(key),
        `${key} should be present in .env.example`,
      ).toBe(true);
    }
  });

  test("pins documented local storage and database ports", () => {
    expect(compose.services.storage_db?.ports).toEqual(["54322:5432"]);
    expect(compose.services.storage?.ports).toEqual(["54321:5000"]);
  });

  test("waits for healthy Postgres before starting storage API", () => {
    expect(compose.services.storage?.depends_on).toEqual({
      storage_db: { condition: "service_healthy" },
    });
    expect(compose.services.storage_db?.healthcheck).toMatchObject({
      test: ["CMD-SHELL", `pg_isready -U ${STORAGE_DB_USER_INTERPOLATION}`],
      interval: "5s",
      timeout: "5s",
      retries: 20,
    });
    expect(compose.services.storage?.healthcheck).toMatchObject({
      test: [
        "CMD-SHELL",
        "wget -q -O - http://localhost:5000/status || exit 1",
      ],
      interval: "10s",
      timeout: "5s",
      retries: 10,
    });
  });

  test("persists database and file storage in named volumes", () => {
    expect(compose.services.storage_db?.volumes).toEqual([
      "storage_db_data:/var/lib/postgresql/data",
    ]);
    expect(compose.services.storage?.volumes).toEqual([
      "storage_data:/var/lib/storage",
    ]);
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "storage_data",
      "storage_db_data",
    ]);
  });
});
