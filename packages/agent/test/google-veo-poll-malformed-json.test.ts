import { afterEach, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return { ...actual, sleepWithAbort: vi.fn(async () => undefined) };
});

vi.mock("../src/api/media-store.ts", () => ({
  persistMediaStream: vi.fn(async () => ({ url: "/api/media/veo.mp4" })),
}));

import { GoogleVideoProvider } from "../src/providers/media-provider.ts";

const OPERATION = "models/veo-2.0-generate-001/operations/op1";
const DOWNLOAD_URI =
  "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media";

function htmlPage(): Response {
  return new Response("<html>captive portal</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function stubVeoFetch(pollResponses: Array<() => Response>) {
  const polls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(":predictLongRunning")) {
        return Response.json({ name: OPERATION, done: false });
      }
      if (url.endsWith(`/v1beta/${OPERATION}`)) {
        polls.push(url);
        const next = pollResponses.shift();
        if (!next) throw new Error("unexpected extra poll");
        return next();
      }
      if (url === DOWNLOAD_URI) {
        return new Response("video", {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return polls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps polling past a single malformed 200 poll body", async () => {
  const polls = stubVeoFetch([
    htmlPage,
    () =>
      Response.json({
        name: OPERATION,
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: DOWNLOAD_URI } }],
          },
        },
      }),
  ]);
  const provider = new GoogleVideoProvider({ apiKey: "veo-key" });

  const result = await provider.generate({ prompt: "A lighthouse" });

  expect(result).toEqual({
    success: true,
    data: { videoUrl: "/api/media/veo.mp4" },
  });
  expect(polls).toHaveLength(2);
});

it("fails promptly with the parse error when poll bodies stay malformed", async () => {
  const polls = stubVeoFetch([htmlPage, htmlPage, htmlPage]);
  const provider = new GoogleVideoProvider({ apiKey: "veo-key" });

  const result = await provider.generate({ prompt: "A lighthouse" });

  expect(result.success).toBe(false);
  expect(result.success ? "" : result.error).toMatch(
    /Google Veo error: malformed poll response \(.*not valid JSON\)$/,
  );
  expect(result.success ? "" : result.error).not.toMatch(/did not complete/);
  expect(polls).toHaveLength(3);
});
