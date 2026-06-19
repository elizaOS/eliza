import { describe, expect, it } from "vitest";
import {
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  PostAgentAutonomyRequestSchema,
  PostAgentExportRequestSchema,
  PostRegistryRegisterRequestSchema,
  PostRegistrySyncRequestSchema,
  PostRegistryUpdateUriRequestSchema,
} from "./agent-routes.js";

describe("PostAgentAutonomyRequestSchema", () => {
  it("accepts enabled=true and false", () => {
    expect(PostAgentAutonomyRequestSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(PostAgentAutonomyRequestSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("rejects non-boolean enabled", () => {
    expect(() =>
      PostAgentAutonomyRequestSchema.parse({ enabled: "yes" }),
    ).toThrow();
  });

  it("rejects missing enabled", () => {
    expect(() => PostAgentAutonomyRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostAgentAutonomyRequestSchema.parse({ enabled: true, force: true }),
    ).toThrow();
  });
});

describe("PostAgentExportRequestSchema", () => {
  it("accepts a 4+ char password", () => {
    expect(PostAgentExportRequestSchema.parse({ password: "1234" })).toEqual({
      password: "1234",
    });
  });

  it("accepts includeLogs flag", () => {
    expect(
      PostAgentExportRequestSchema.parse({
        password: "1234",
        includeLogs: true,
      }),
    ).toEqual({ password: "1234", includeLogs: true });
  });

  it("rejects short password", () => {
    expect(() =>
      PostAgentExportRequestSchema.parse({ password: "12" }),
    ).toThrow(
      new RegExp(
        `at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters is required`,
      ),
    );
  });

  it("rejects missing password", () => {
    expect(() => PostAgentExportRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostAgentExportRequestSchema.parse({ password: "1234", verbose: true }),
    ).toThrow();
  });
});

describe("PostRegistryRegisterRequestSchema", () => {
  it("accepts an empty body (handler defaults are applied)", () => {
    expect(PostRegistryRegisterRequestSchema.parse({})).toEqual({});
  });

  it("trims all string fields", () => {
    expect(
      PostRegistryRegisterRequestSchema.parse({
        name: "  Eliza  ",
        endpoint: "  https://api  ",
        tokenURI: "  ipfs://x  ",
      }),
    ).toEqual({
      name: "Eliza",
      endpoint: "https://api",
      tokenURI: "ipfs://x",
    });
  });

  it("absorbs whitespace-only fields", () => {
    expect(
      PostRegistryRegisterRequestSchema.parse({
        name: "  ",
        endpoint: " ",
        tokenURI: "  ",
      }),
    ).toEqual({});
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostRegistryRegisterRequestSchema.parse({
        name: "x",
        chainId: 1,
      }),
    ).toThrow();
  });
});

describe("PostRegistryUpdateUriRequestSchema", () => {
  it("trims tokenURI", () => {
    expect(
      PostRegistryUpdateUriRequestSchema.parse({ tokenURI: "  ipfs://x  " }),
    ).toEqual({ tokenURI: "ipfs://x" });
  });

  it("rejects whitespace-only tokenURI", () => {
    expect(() =>
      PostRegistryUpdateUriRequestSchema.parse({ tokenURI: " " }),
    ).toThrow(/tokenURI is required/);
  });

  it("rejects missing tokenURI", () => {
    expect(() => PostRegistryUpdateUriRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostRegistryUpdateUriRequestSchema.parse({
        tokenURI: "x",
        chainId: 1,
      }),
    ).toThrow();
  });
});

describe("PostRegistrySyncRequestSchema", () => {
  it("accepts the same shape as register", () => {
    expect(
      PostRegistrySyncRequestSchema.parse({
        name: "Eliza",
        endpoint: "https://api",
        tokenURI: "ipfs://x",
      }),
    ).toEqual({
      name: "Eliza",
      endpoint: "https://api",
      tokenURI: "ipfs://x",
    });
  });
});
