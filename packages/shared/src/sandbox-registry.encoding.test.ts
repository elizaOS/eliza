/** Sandbox Redis URL userinfo rejects malformed percent-encoding explicitly. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    readonly code: string;
    constructor(message: string, options: { code: string; cause?: unknown }) {
      super(message, { cause: options.cause });
      this.code = options.code;
    }
  },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  decodeRedisUrlUserinfo,
  SandboxRegistryRedisUrlError,
} from "./sandbox-registry.ts";

describe("decodeRedisUrlUserinfo", () => {
  it.each(["%", "%ZZ", "%E0%A4%A"])(
    "rejects malformed userinfo %s",
    (userinfo) => {
      expect(() => decodeRedisUrlUserinfo(userinfo)).toThrow(
        SandboxRegistryRedisUrlError,
      );
    },
  );

  it("still decodes a valid %20 userinfo half", () => {
    expect(decodeRedisUrlUserinfo("user%20name")).toBe("user name");
  });
});
