import { createMockRuntime } from "@elizaos/testing";
import { afterEach, expect, it, vi } from "vitest";
import { GoogleWorkspaceService } from "./service.js";

afterEach(() => vi.unstubAllEnvs());

it("accepts local runtime endpoints and rejects remote character overrides", () => {
  vi.stubEnv("ELIZA_MOCK_GOOGLE_BASE", "");
  const runtime = (endpoint: string) => createMockRuntime({ getSetting: () => endpoint });
  expect(() => new GoogleWorkspaceService(runtime("http://127.0.0.1:1234"))).not.toThrow();
  for (const endpoint of ["https://example.test", "http://user:password@localhost", "invalid"])
    expect(() => new GoogleWorkspaceService(runtime(endpoint))).toThrow(
      expect.objectContaining({ code: "GOOGLE_MOCK_ENDPOINT_INVALID" })
    );
  expect(
    () =>
      new GoogleWorkspaceService(runtime("https://example.test"), {
        apiRootUrl: "http://127.0.0.1:1234",
      })
  ).not.toThrow();
});

it("preserves explicit host environment overrides", () => {
  vi.stubEnv("ELIZA_MOCK_GOOGLE_BASE", "https://host-owned-fixture.example.test");
  expect(
    () =>
      new GoogleWorkspaceService(
        createMockRuntime({ getSetting: () => process.env.ELIZA_MOCK_GOOGLE_BASE })
      )
  ).not.toThrow();
});
