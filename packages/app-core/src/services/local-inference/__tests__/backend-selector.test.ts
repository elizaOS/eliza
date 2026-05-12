import { describe, expect, it } from "vitest";

import { readBackendEnvOverride, selectBackend } from "../backend-selector";

describe("selectBackend", () => {
  it("forces ffi-streaming on mobile when FFI is supported", () => {
    expect(
      selectBackend({
        platform: "mobile",
        preferFfi: false,
        ffiSupported: true,
      }),
    ).toBe("ffi-streaming");
  });

  it("throws on mobile when FFI is missing", () => {
    expect(() =>
      selectBackend({
        platform: "mobile",
        preferFfi: false,
        ffiSupported: false,
      }),
    ).toThrow(/streaming-LLM FFI symbols/);
  });

  it("desktop defaults to http-server", () => {
    expect(
      selectBackend({
        platform: "desktop",
        preferFfi: false,
        ffiSupported: true,
      }),
    ).toBe("http-server");
  });

  it("desktop opts in to ffi-streaming with preferFfi + ffiSupported", () => {
    expect(
      selectBackend({
        platform: "desktop",
        preferFfi: true,
        ffiSupported: true,
      }),
    ).toBe("ffi-streaming");
  });

  it("desktop preferFfi without ffiSupported stays on http-server", () => {
    expect(
      selectBackend({
        platform: "desktop",
        preferFfi: true,
        ffiSupported: false,
      }),
    ).toBe("http-server");
  });

  it("envOverride=ffi wins on desktop when supported", () => {
    expect(
      selectBackend({
        platform: "desktop",
        preferFfi: false,
        ffiSupported: true,
        envOverride: "ffi",
      }),
    ).toBe("ffi-streaming");
  });

  it("envOverride=ffi without ffiSupported throws", () => {
    expect(() =>
      selectBackend({
        platform: "desktop",
        preferFfi: false,
        ffiSupported: false,
        envOverride: "ffi",
      }),
    ).toThrow(/does not export the streaming-LLM symbols/);
  });

  it("envOverride=http forces http-server on desktop", () => {
    expect(
      selectBackend({
        platform: "desktop",
        preferFfi: true,
        ffiSupported: true,
        envOverride: "http",
      }),
    ).toBe("http-server");
  });

  it("envOverride=http is rejected on mobile", () => {
    expect(() =>
      selectBackend({
        platform: "mobile",
        preferFfi: false,
        ffiSupported: true,
        envOverride: "http",
      }),
    ).toThrow(/not supported on mobile/);
  });
});

describe("readBackendEnvOverride", () => {
  it("returns auto for explicit auto", () => {
    expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "auto" })).toBe(
      "auto",
    );
  });

  it("normalizes ffi and http aliases", () => {
    expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "FFI" })).toBe(
      "ffi",
    );
    expect(
      readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "ffi-streaming" }),
    ).toBe("ffi");
    expect(
      readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "http-server" }),
    ).toBe("http");
    expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "server" })).toBe(
      "http",
    );
  });

  it("returns null for unset / unknown", () => {
    expect(readBackendEnvOverride({})).toBeNull();
    expect(
      readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "foo" }),
    ).toBeNull();
  });
});
