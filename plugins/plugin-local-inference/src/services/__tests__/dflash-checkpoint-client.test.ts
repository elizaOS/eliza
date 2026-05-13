/**
 * Unit tests for `CheckpointClient`. The client is pure HTTP-shape glue, so
 * the mocks just record what URLs / methods / bodies the client emits and
 * assert against them.
 */

import { describe, expect, it } from "vitest";
import {
  CheckpointClient,
  type CheckpointFetch,
  CheckpointHttpError,
} from "../dflash-checkpoint-client";

interface RecordedRequest {
  url: string;
  method: string | undefined;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

function makeFetch(opts: {
  responses: FakeResponse[];
  recorded: RecordedRequest[];
}): CheckpointFetch {
  let i = 0;
  return async (url, init) => {
    opts.recorded.push({ url: String(url), method: init?.method });
    const response = opts.responses[i] ?? opts.responses.at(-1);
    if (!response) {
      throw new Error("no response configured");
    }
    i += 1;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      async text() {
        return response.body;
      },
    };
  };
}

describe("CheckpointClient", () => {
  it("saveCheckpoint POSTs /slots/<id>/save?filename=<name> and returns handle", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded,
        responses: [{ ok: true, status: 200, statusText: "OK", body: "{}" }],
      }),
    });
    const handle = await client.saveCheckpoint(3, "C1-turn-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toBe(
      "http://127.0.0.1:9999/slots/3/save?filename=C1-turn-1",
    );
    expect(handle.slotId).toBe(3);
    expect(handle.filename).toBe("C1-turn-1");
    expect(handle.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("restoreCheckpoint POSTs /slots/<id>/restore?filename=<name>", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999/",
      fetchImpl: makeFetch({
        recorded,
        responses: [{ ok: true, status: 200, statusText: "OK", body: "{}" }],
      }),
    });
    await client.restoreCheckpoint(5, "C1-turn-2");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    // trailing slash on baseUrl is stripped
    expect(recorded[0].url).toBe(
      "http://127.0.0.1:9999/slots/5/restore?filename=C1-turn-2",
    );
  });

  it("cancelSlot issues DELETE /slots/<id>", async () => {
    const recorded: RecordedRequest[] = [];
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded,
        responses: [
          { ok: true, status: 204, statusText: "No Content", body: "" },
        ],
      }),
    });
    await client.cancelSlot(7);
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url).toBe("http://127.0.0.1:9999/slots/7");
  });

  it("non-2xx responses raise CheckpointHttpError carrying status + body", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded: [],
        responses: [
          {
            ok: false,
            status: 404,
            statusText: "Not Found",
            body: '{"error":"missing"}',
          },
        ],
      }),
    });
    await expect(
      client.restoreCheckpoint(1, "C1-missing"),
    ).rejects.toMatchObject({
      name: "CheckpointHttpError",
      status: 404,
      responseBody: '{"error":"missing"}',
    });
  });

  it("rejects negative slot ids", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({ recorded: [], responses: [] }),
    });
    await expect(client.saveCheckpoint(-1, "C1")).rejects.toThrow(
      /invalid slotId/,
    );
  });

  it("rejects names containing forbidden chars", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({ recorded: [], responses: [] }),
    });
    await expect(client.saveCheckpoint(0, "../etc/passwd")).rejects.toThrow(
      /invalid checkpoint name/,
    );
    await expect(client.saveCheckpoint(0, "")).rejects.toThrow(
      /invalid checkpoint name/,
    );
  });

  it("probeSupported returns true when /health advertises slot_save_path", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded: [],
        responses: [
          {
            ok: true,
            status: 200,
            statusText: "OK",
            body: JSON.stringify({ slot_save_path: "/tmp/eliza-slots" }),
          },
        ],
      }),
    });
    await expect(client.probeSupported()).resolves.toBe(true);
  });

  it("probeSupported returns true when /health explicitly advertises ctx_checkpoints_supported", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded: [],
        responses: [
          {
            ok: true,
            status: 200,
            statusText: "OK",
            body: JSON.stringify({ ctx_checkpoints_supported: true }),
          },
        ],
      }),
    });
    await expect(client.probeSupported()).resolves.toBe(true);
  });

  it("probeSupported returns false on non-JSON or unmarked /health bodies", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch({
        recorded: [],
        responses: [{ ok: true, status: 200, statusText: "OK", body: "ok" }],
      }),
    });
    await expect(client.probeSupported()).resolves.toBe(false);
  });

  it("probeSupported returns false when /health errors", async () => {
    const client = new CheckpointClient({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(client.probeSupported()).resolves.toBe(false);
  });

  it("CheckpointHttpError preserves name for instanceof checks", () => {
    const err = new CheckpointHttpError("boom", 500, "body");
    expect(err.name).toBe("CheckpointHttpError");
    expect(err.status).toBe(500);
  });
});
