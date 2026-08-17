/**
 * Verifies the shared Circle IRIS request boundary installs its production timeout signal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CIRCLE_ATTESTATION_FETCH_TIMEOUT_MS,
  fetchCircleAttestation,
} from "./attestation-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchCircleAttestation", () => {
  it("passes a ten-second AbortSignal to fetch", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCircleAttestation(
      "https://iris.example.test/v2/messages/0/hash",
    );

    expect(timeout).toHaveBeenCalledExactlyOnceWith(
      CIRCLE_ATTESTATION_FETCH_TIMEOUT_MS,
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://iris.example.test/v2/messages/0/hash",
      {
        headers: { Accept: "application/json" },
        signal,
      },
    );
  });
});
