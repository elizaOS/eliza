/**
 * Unit tests for LifeOpsServiceError.
 */

import { describe, expect, it } from "vitest";
import { LifeOpsServiceError } from "./service-error.js";

describe("LifeOpsServiceError", () => {
  it("instantiates with status and message", () => {
    const error = new LifeOpsServiceError(404, "Task not found");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LifeOpsServiceError);
    expect(error.name).toBe("LifeOpsServiceError");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Task not found");
    expect(error.code).toBeUndefined();
    expect(error.stack).toBeDefined();
  });

  it("stores optional error code when provided", () => {
    const error = new LifeOpsServiceError(
      400,
      "Invalid timezone specified",
      "INVALID_TIMEZONE",
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe("Invalid timezone specified");
    expect(error.code).toBe("INVALID_TIMEZONE");
  });

  it("can be thrown and caught in standard error handling flows", () => {
    expect(() => {
      throw new LifeOpsServiceError(403, "Permission denied", "FORBIDDEN");
    }).toThrowError(LifeOpsServiceError);
  });
});
