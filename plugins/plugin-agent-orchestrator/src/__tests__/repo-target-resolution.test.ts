/** Exercises repository routing against adversarial prose and tenant changes. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetRepositoryIdentityCacheForTests,
  resolveRequestedRepository,
} from "../services/repo-target-resolution.js";

function runtime(token: string) {
  return {
    getSetting: (key: string) => (key === "GITHUB_TOKEN" ? token : undefined),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => resetRepositoryIdentityCacheForTests());

describe("resolveRequestedRepository", () => {
  it("does not promote unrelated slash-delimited prose into routing authority", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveRequestedRepository({
        runtime: runtime("tenant-a"),
        params: {},
        requestTexts: [
          "review packages/core/src/errors.ts; this repository needs care",
        ],
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires authenticated existence for an explicit prose slug", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(
      resolveRequestedRepository({
        runtime: runtime("tenant-a"),
        params: {},
        requestTexts: ["fix this in repo elizaOS/not-a-repo"],
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts an explicit provider URL without requiring identity lookup", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveRequestedRepository({
        runtime: runtime(""),
        params: {},
        requestTexts: ["please update https://github.com/elizaOS/eliza"],
        fetchImpl,
      }),
    ).resolves.toBe("https://github.com/elizaOS/eliza.git");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keys successful identity caching by token and retries failures", async () => {
    let transientAttempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(input).endsWith("/user")) {
        if (auth === "token transient") {
          transientAttempts += 1;
          return transientAttempts === 1
            ? jsonResponse({}, 503)
            : jsonResponse({ login: "Recovered" });
        }
        return jsonResponse({
          login: auth === "token tenant-a" ? "Alice" : "Bob",
        });
      }
      return jsonResponse({});
    });

    const resolveMine = (token: string, name: string) =>
      resolveRequestedRepository({
        runtime: runtime(token),
        params: { repo: name },
        requestTexts: [`open a PR in my ${name} repo`],
        fetchImpl,
      });

    await expect(resolveMine("tenant-a", "widgets")).resolves.toContain(
      "/Alice/widgets.git",
    );
    await expect(resolveMine("tenant-b", "widgets")).resolves.toContain(
      "/Bob/widgets.git",
    );
    await expect(resolveMine("tenant-a", "other")).resolves.toContain(
      "/Alice/other.git",
    );
    await expect(resolveMine("transient", "retry")).resolves.toBeUndefined();
    await expect(resolveMine("transient", "retry")).resolves.toContain(
      "/Recovered/retry.git",
    );
  });
});
