import { afterEach, describe, expect, mock, test } from "bun:test";
import { getClientApiKeySecret } from "./api-keys";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("getClientApiKeySecret", () => {
  test("does not fetch old full keys from the API key list", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        keys: [
          {
            id: "api-key-1",
            key: "eliza_old_full_secret",
            key_prefix: "eliza_ol",
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getClientApiKeySecret("api-key-1")).rejects.toThrow(
      "Full API keys are only available immediately after creation.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
