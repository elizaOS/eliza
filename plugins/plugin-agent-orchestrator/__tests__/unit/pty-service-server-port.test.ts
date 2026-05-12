import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveServerPort } from "../../src/services/pty-service.ts";

function makeRuntime(settings: Record<string, string | number | undefined>) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("resolveServerPort", () => {
  it("prefers explicit SERVER_PORT override over deployment env vars", () => {
    const runtime = makeRuntime({
      SERVER_PORT: "9999",
      ELIZA_API_PORT: "47831",
<<<<<<< HEAD
      MILADY_API_PORT: "31337",
=======
      ELIZA_PORT: "31337",
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
    });
    expect(resolveServerPort(runtime)).toBe("9999");
  });

  it("falls back to ELIZA_API_PORT when SERVER_PORT is not set", () => {
    const runtime = makeRuntime({
      ELIZA_API_PORT: "47831",
<<<<<<< HEAD
      MILADY_API_PORT: "31337",
=======
      ELIZA_PORT: "31337",
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
    });
    expect(resolveServerPort(runtime)).toBe("47831");
  });

  it("falls back to MILADY_API_PORT when only the legacy alias is set", () => {
    const runtime = makeRuntime({
      MILADY_API_PORT: "31337",
    });
    expect(resolveServerPort(runtime)).toBe("31337");
  });

  it("falls back to ELIZA_PORT when SERVER_PORT and ELIZA_API_PORT are not set", () => {
    const runtime = makeRuntime({
      ELIZA_PORT: "31337",
    });
    expect(resolveServerPort(runtime)).toBe("31337");
  });

  it("returns the dev-UI default 2138 only when nothing else is configured", () => {
    const runtime = makeRuntime({});
    expect(resolveServerPort(runtime)).toBe("2138");
  });

  it("accepts numeric port settings", () => {
    const runtime = makeRuntime({ ELIZA_API_PORT: 47831 });
    expect(resolveServerPort(runtime)).toBe("47831");
  });

  it("ignores empty-string settings and walks to the next key", () => {
    const runtime = makeRuntime({
      SERVER_PORT: "   ",
      ELIZA_API_PORT: "47831",
    });
    expect(resolveServerPort(runtime)).toBe("47831");
  });
});
