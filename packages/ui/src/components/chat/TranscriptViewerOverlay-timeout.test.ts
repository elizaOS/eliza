/**
 * Behavioral TranscriptViewerOverlay inline-text deadline. Executes
 * getTranscriptOverlayTextWithFetch under abort — not a source-grep, and
 * not #21385 internal-eliza-conversation-fetch.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  client: { getTranscript: vi.fn() },
}));

vi.mock("../../app-navigate-view", () => ({
  navigateBrowserPath: vi.fn(),
}));

vi.mock("../../hooks/useRole", () => ({
  useRole: () => ({ role: "owner" }),
}));

vi.mock("../RoleGate", () => ({
  RoleGate: ({ children }: { children: unknown }) => children,
}));

vi.mock("lucide-react", () => ({
  Check: () => null,
  Copy: () => null,
  Download: () => null,
  FileAudio: () => null,
  Library: () => null,
  Loader2: () => null,
  LockKeyhole: () => null,
  Pencil: () => null,
  Share2: () => null,
  ShieldCheck: () => null,
  Trash2: () => null,
  Undo2: () => null,
  UserRoundMinus: () => null,
  X: () => null,
}));

vi.mock("../ui/badge", () => ({ Badge: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/textarea", () => ({ Textarea: () => null }));

import {
  getTranscriptOverlayTextWithFetch,
  TRANSCRIPT_OVERLAY_FETCH_TIMEOUT_MS,
} from "./TranscriptViewerOverlay";

const URL = "http://test.local/api/media/deadbeef.md";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected transcript-overlay abort signal");
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("TranscriptViewerOverlay inline-text deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(TRANSCRIPT_OVERLAY_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled transcript GET at the injected deadline", async () => {
    await expect(
      getTranscriptOverlayTextWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("preserves caller cancellation while retaining the deadline", async () => {
    const caller = new AbortController();
    const request = getTranscriptOverlayTextWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      caller.signal,
    );

    caller.abort(new DOMException("overlay closed", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves cancellation from an already-aborted caller", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("overlay already closed", "AbortError"));

    await expect(
      getTranscriptOverlayTextWithFetch(
        URL,
        stallUntilAborted(),
        1_000,
        caller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts while a successful response body is still stalled", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const signal = init?.signal;
            if (!signal) {
              controller.error(
                new Error("expected transcript-overlay abort signal"),
              );
              return;
            }
            const fail = () => controller.error(signal.reason);
            if (signal.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
          },
        }),
        { status: 200 },
      );

    await expect(
      getTranscriptOverlayTextWithFetch(URL, fetchImpl, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed transcript GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getTranscriptOverlayTextWithFetch(URL, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful transcript GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("hello transcript", { status: 200 });
    };

    const text = await getTranscriptOverlayTextWithFetch(URL, fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(text).toBe("hello transcript");
  });
});
