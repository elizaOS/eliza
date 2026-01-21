import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "../lib/db/schema";

let pglite: PGlite | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

// Mock the database module
vi.mock("@/lib/db", () => ({
  getDatabase: vi.fn().mockImplementation(async () => {
    if (!db) {
      throw new Error("Database not initialized");
    }
    return db;
  }),
  usersTable: schema.usersTable,
}));

// Mock the logger to avoid console output in tests
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
const { GET } = await import("../app/api/health/route");

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS soulmates_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone VARCHAR(20) NOT NULL UNIQUE,
      email VARCHAR(255),
      name VARCHAR(255),
      location VARCHAR(255),
      credits INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
});

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when database is healthy", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
  });

  it("returns valid JSON structure", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("database");
  });

  it("returns healthy status when DB is up", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("healthy");
    expect(body.checks.database.status).toBe("up");
  });

  it("includes latency in milliseconds", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.checks.database.latencyMs).toBeTypeOf("number");
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("includes version string", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.version).toBe("2.0.0");
  });

  it("includes ISO timestamp", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
    );
  });
});

describe("GET /api/health - database failure", () => {
  it("returns 503 when database query fails", async () => {
    const { getDatabase } = await import("@/lib/db");
    const mockGetDatabase = getDatabase as ReturnType<typeof vi.fn>;

    // Make database throw
    mockGetDatabase.mockRejectedValueOnce(new Error("Connection refused"));

    const response = await GET();

    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("unhealthy");
    expect(body.checks.database.status).toBe("down");
    expect(body.checks.database.error).toBe("Connection refused");
  });
});

afterAll(async () => {
  if (pglite) {
    await pglite.close();
  }
});
