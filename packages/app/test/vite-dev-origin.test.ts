import { describe, expect, it } from "vitest";
import { resolveViteDevServerRuntime } from "../vite-dev-origin";

describe("resolveViteDevServerRuntime", () => {
  it("does not pin loopback by default", () => {
    expect(resolveViteDevServerRuntime({}, 2138)).toEqual({
      hmr: { port: 2138 },
    });
  });

  it("pins loopback when desktop watch requests it", () => {
    expect(
      resolveViteDevServerRuntime({ ELIZA_VITE_LOOPBACK_ORIGIN: "1" }, 2138),
    ).toEqual({
      origin: "http://127.0.0.1:2138",
      hmr: {
        host: "127.0.0.1",
        port: 2138,
        protocol: "ws",
      },
    });
  });

  it("uses an explicit public origin for remote dev clients", () => {
    expect(
      resolveViteDevServerRuntime(
        { ELIZA_VITE_ORIGIN: "https://192.168.1.42:443" },
        2138,
      ),
    ).toEqual({
      origin: "https://192.168.1.42",
      hmr: {
        host: "192.168.1.42",
        port: 443,
        protocol: "wss",
      },
    });
  });

  it("lets ELIZA_HMR_HOST override the inferred host", () => {
    expect(
      resolveViteDevServerRuntime(
        {
          ELIZA_VITE_ORIGIN: "http://10.0.0.2:9000",
          ELIZA_HMR_HOST: "10.0.0.99",
        },
        2138,
      ),
    ).toEqual({
      origin: "http://10.0.0.2:9000",
      hmr: {
        host: "10.0.0.99",
        port: 9000,
        protocol: "ws",
      },
    });
  });
});
