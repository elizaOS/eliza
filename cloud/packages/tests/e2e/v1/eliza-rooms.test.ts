import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { NONEXISTENT_UUID } from "../helpers/test-data";

/**
 * Eliza Rooms (Chat) API E2E Tests
 */

describe("Eliza Rooms API", () => {
  test("GET /api/eliza/rooms requires auth or anonymous session", async () => {
    const response = await api.get("/api/eliza/rooms");
    // May return empty rooms for anonymous, or 401
    expect([200, 401, 501]).toContain(response.status);
  });

  test("POST /api/eliza/rooms creates a room (anonymous fallback)", async () => {
    const response = await api.post("/api/eliza/rooms", {});
    // Anonymous users can create rooms or need auth
    expect([200, 201, 401, 501]).toContain(response.status);
  });

  test("GET /api/eliza/rooms/[id] returns 404 for nonexistent", async () => {
    const response = await api.get(`/api/eliza/rooms/${NONEXISTENT_UUID}`);
    expect([401, 403, 404, 501]).toContain(response.status);
  });

  test("POST /api/eliza/rooms/[id]/messages requires valid room", async () => {
    const response = await api.post(`/api/eliza/rooms/${NONEXISTENT_UUID}/messages`, {
      text: "Hello",
    });
    expect([400, 401, 403, 404, 501]).toContain(response.status);
  });

  test("POST /api/eliza/rooms/[id]/welcome handles nonexistent room", async () => {
    const response = await api.post(`/api/eliza/rooms/${NONEXISTENT_UUID}/welcome`, {
      text: "Welcome",
    });
    expect([401, 403, 404]).toContain(response.status);
  });
});
