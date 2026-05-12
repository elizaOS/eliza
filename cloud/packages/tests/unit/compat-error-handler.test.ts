import { describe, expect, test } from "bun:test";
import { handleCompatError } from "../../../apps/api/compat/_lib/error-handler";
import { ForbiddenError } from "../../lib/api/errors";

describe("handleCompatError", () => {
  test("maps ForbiddenError to 403", async () => {
    const res = handleCompatError(new ForbiddenError("no access"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("no access");
  });

  test("maps auth-like errors to 401", () => {
    for (const message of [
      "Unauthorized token",
      "Invalid API key",
      "Invalid token",
      "Invalid credentials",
      "Invalid service key",
    ]) {
      expect(handleCompatError(new Error(message)).status).toBe(401);
    }
  });

  test("maps forbidden errors to 403", () => {
    expect(handleCompatError(new Error("Forbidden access")).status).toBe(403);
  });

  test("does not classify generic invalid input as authentication failure", () => {
    for (const message of [
      "Invalid agent config",
      "Invalid JSON body",
      "Invalid request data",
      "Invalid parameter: limit must be positive",
    ]) {
      expect(handleCompatError(new Error(message)).status).toBe(500);
    }
  });

  test("maps unknown and generic errors to 500", async () => {
    const unknown = handleCompatError("something broke");
    expect(unknown.status).toBe(500);
    await expect(unknown.json()).resolves.toMatchObject({
      error: "Internal server error",
    });

    expect(handleCompatError(new Error("db connection lost")).status).toBe(500);
  });
});
