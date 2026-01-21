import { describe, expect, it } from "vitest";
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  parseBody,
  serverError,
  toProfileData,
  unauthorized,
} from "../lib/api-utils";
import type { UserRecord } from "../lib/store";

describe("API response helpers", () => {
  describe("unauthorized", () => {
    it("returns 401 status", async () => {
      const response = unauthorized();
      expect(response.status).toBe(401);
    });

    it("returns correct error structure", async () => {
      const response = unauthorized();
      const body = await response.json();
      expect(body).toEqual({ ok: false, error: "Unauthorized" });
    });
  });

  describe("forbidden", () => {
    it("returns 403 status", async () => {
      const response = forbidden();
      expect(response.status).toBe(403);
    });

    it("returns correct error structure", async () => {
      const response = forbidden();
      const body = await response.json();
      expect(body).toEqual({ ok: false, error: "Forbidden" });
    });
  });

  describe("badRequest", () => {
    it("returns 400 status", async () => {
      const response = badRequest("Invalid input");
      expect(response.status).toBe(400);
    });

    it("returns custom error message", async () => {
      const response = badRequest("Custom error message");
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Custom error message");
    });

    it("includes extra properties when provided", async () => {
      const response = badRequest("Validation failed", {
        errors: { name: "Name is required" },
        code: "VALIDATION_ERROR",
      });
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Validation failed");
      expect(body.errors).toEqual({ name: "Name is required" });
      expect(body.code).toBe("VALIDATION_ERROR");
    });

    it("handles empty extras", async () => {
      const response = badRequest("Error", {});
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Error");
    });
  });

  describe("notFound", () => {
    it("returns 404 status", async () => {
      const response = notFound("Resource not found");
      expect(response.status).toBe(404);
    });

    it("returns custom error message", async () => {
      const response = notFound("User not found");
      const body = await response.json();
      expect(body).toEqual({ ok: false, error: "User not found" });
    });
  });

  describe("serverError", () => {
    it("returns 500 status", async () => {
      const response = serverError("Internal error");
      expect(response.status).toBe(500);
    });

    it("returns custom error message", async () => {
      const response = serverError("Database connection failed");
      const body = await response.json();
      expect(body).toEqual({ ok: false, error: "Database connection failed" });
    });
  });

  describe("ok", () => {
    it("returns 200 status", async () => {
      const response = ok({ message: "success" });
      expect(response.status).toBe(200);
    });

    it("returns data wrapped in success structure", async () => {
      const data = { id: 1, name: "Test" };
      const response = ok(data);
      const body = await response.json();
      expect(body).toEqual({ ok: true, data: { id: 1, name: "Test" } });
    });

    it("handles null data", async () => {
      const response = ok(null);
      const body = await response.json();
      expect(body).toEqual({ ok: true, data: null });
    });

    it("handles array data", async () => {
      const response = ok([1, 2, 3]);
      const body = await response.json();
      expect(body).toEqual({ ok: true, data: [1, 2, 3] });
    });

    it("handles string data", async () => {
      const response = ok("success");
      const body = await response.json();
      expect(body).toEqual({ ok: true, data: "success" });
    });

    it("handles nested objects", async () => {
      const data = { user: { profile: { name: "Test" } } };
      const response = ok(data);
      const body = await response.json();
      expect(body.data.user.profile.name).toBe("Test");
    });
  });
});

describe("parseBody", () => {
  it("parses valid JSON", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ name: "Test", age: 25 }),
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseBody<{ name: string; age: number }>(request);
    expect(result).toEqual({ name: "Test", age: 25 });
  });

  it("returns null for invalid JSON", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "not valid json",
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseBody(request);
    expect(result).toBeNull();
  });

  it("returns null for empty body", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseBody(request);
    expect(result).toBeNull();
  });

  it("parses nested objects", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        user: { name: "Test" },
        settings: { theme: "dark" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseBody<{
      user: { name: string };
      settings: { theme: string };
    }>(request);
    expect(result?.user.name).toBe("Test");
    expect(result?.settings.theme).toBe("dark");
  });

  it("parses arrays", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify([1, 2, 3]),
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseBody<number[]>(request);
    expect(result).toEqual([1, 2, 3]);
  });

  it("handles GET requests without body", async () => {
    const request = new Request("http://localhost", {
      method: "GET",
    });
    const result = await parseBody(request);
    expect(result).toBeNull();
  });
});

describe("toProfileData", () => {
  const baseUser: UserRecord = {
    id: "user-123",
    phone: "+15551234567",
    name: "John Doe",
    email: "john@example.com",
    location: "New York",
    credits: 100,
    status: "active",
    isAdmin: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
  };

  it("transforms UserRecord to profile data", () => {
    const result = toProfileData(baseUser);
    expect(result).toEqual({
      id: "user-123",
      phone: "+15551234567",
      name: "John Doe",
      email: "john@example.com",
      location: "New York",
      credits: 100,
      status: "active",
      isAdmin: false,
      allowlisted: true,
    });
  });

  it("sets allowlisted true when status is active", () => {
    const result = toProfileData({ ...baseUser, status: "active" });
    expect(result.allowlisted).toBe(true);
  });

  it("sets allowlisted false when status is blocked", () => {
    const result = toProfileData({ ...baseUser, status: "blocked" });
    expect(result.allowlisted).toBe(false);
  });

  it("handles null values in optional fields", () => {
    const user: UserRecord = {
      ...baseUser,
      name: null,
      email: null,
      location: null,
    };
    const result = toProfileData(user);
    expect(result.name).toBeNull();
    expect(result.email).toBeNull();
    expect(result.location).toBeNull();
  });

  it("preserves admin status", () => {
    const adminUser = { ...baseUser, isAdmin: true };
    const result = toProfileData(adminUser);
    expect(result.isAdmin).toBe(true);
  });

  it("preserves credit count", () => {
    const richUser = { ...baseUser, credits: 10000 };
    const result = toProfileData(richUser);
    expect(result.credits).toBe(10000);
  });

  it("preserves zero credits", () => {
    const brokeUser = { ...baseUser, credits: 0 };
    const result = toProfileData(brokeUser);
    expect(result.credits).toBe(0);
  });

  it("excludes createdAt and updatedAt from result", () => {
    const result = toProfileData(baseUser);
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
  });
});
