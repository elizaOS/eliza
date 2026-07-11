/**
 * REAL-AUDIO transcript e2e (#8789) — runs in the `chromium-voice-mic` project
 * (Chromium launched with --use-file-for-fake-audio-capture=known-phrase.wav).
 *
 * This drives the REAL ContinuousChatOverlay transcript flow end-to-end with no
 * human and no microphone:
 *
 *   tap mic (hands-free) -> run /transcribe (transcription mode) -> the REAL
 *   local-ASR recorder opens the (fake) device, WAV-encodes the injected audio,
 *   and POSTs it to /api/asr/local-inference -> a transcript session accumulates
 *   -> run /transcribe again to finalize -> the shell POSTs the captured audio
 *   (audioBase64) to /api/transcripts and drops a transcript chip into the
 *   composer -> send -> the message bubble shows a transcript ATTACHMENT tile ->
 *   tap it to open the editable viewer.
 *
 * The ASR / transcript / media / knowledge BACKENDS are mocked (not provisioned in
 * CI); the AUDIO IN, the WAV capture, the POST bodies, and every client step are
 * REAL.
 *
 * Split by design (the live capture->finalize->attachment chain is timing-
 * sensitive): test 1 is the REAL-AUDIO + LINKAGE proof; test 2 drives the SAME
 * real chain to the attachment, then exhaustively exercises every VIEWER action,
 * the TRANSCRIPTS view player, and the KNOWLEDGE link.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/transcript-realaudio.spec.ts
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

// Real fake-device audio plus ui-smoke live-stack setup can exceed the default
// smoke timeout on loaded developer machines.
test.setTimeout(360_000);

const TRANSCRIPT_TEXT = "what time is it";
const TRANSCRIPT_ID = "transcript-realaudio-e2e";
const MEDIA_PATH = "/api/media/transcript-realaudio.wav";
const TRANSCRIBE_COMMAND_CATALOG = {
  commands: [
    {
      key: "transcribe",
      nativeName: "transcribe",
      description: "Toggle long-form transcription",
      textAliases: ["/transcribe"],
      scope: "both",
      acceptsArgs: false,
      args: [],
      requiresAuth: false,
      requiresElevated: false,
      target: { kind: "client", clientAction: "toggle-transcription" },
      source: "builtin",
    },
  ],
  surface: "gui",
  agentId: null,
  generatedAt: "2026-01-01T00:00:00.000Z",
};
// A short caption typed before sending the transcript attachment. The overlay
// thread drops empty-content turns from its `visibleMessages`, so the user turn
// that carries the transcript tile must have text — typing a caption (a real,
// supported flow: "send it with any typed text") keeps the bubble + its tile.
const TRANSCRIPT_CAPTION = "Here is the recording";

/** A real, small mono PCM16 WAV (RIFF header + a 220Hz tone) — served as the
 *  transcript audio so <audio> playback has a real source. */
function tinyWav(seconds = 0.4, sampleRate = 16000): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)),
      i * 2,
    );
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const SAVED_TRANSCRIPT = {
  id: TRANSCRIPT_ID,
  title: "Voice transcript",
  createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
  endedAt: Date.parse("2026-01-01T00:00:03.000Z"),
  durationMs: 3000,
  audioUrl: MEDIA_PATH,
  audioContentType: "audio/wav",
  segments: [
    {
      id: "seg-0",
      speakerLabel: "Speaker 1",
      startMs: 0,
      endMs: 3000,
      text: TRANSCRIPT_TEXT,
      words: [
        { text: "what", startMs: 0, endMs: 600 },
        { text: "time", startMs: 600, endMs: 1400 },
        { text: "is", startMs: 1400, endMs: 2000 },
        { text: "it", startMs: 2000, endMs: 3000 },
      ],
      confidence: 0.95,
    },
  ],
  source: "voice-session" as const,
  scope: "owner-private" as const,
  status: "ready" as const,
  speakerCount: 1,
  knowledgeDocumentId: "doc-transcript-1",
};

const SAVED_SUMMARY = {
  id: TRANSCRIPT_ID,
  title: SAVED_TRANSCRIPT.title,
  createdAt: SAVED_TRANSCRIPT.createdAt,
  durationMs: SAVED_TRANSCRIPT.durationMs,
  speakerCount: 1,
  status: "ready" as const,
  preview: TRANSCRIPT_TEXT,
  hasAudio: true,
};

const KNOWLEDGE_DOC = {
  id: "doc-transcript-1",
  filename: "Voice transcript.md",
  contentType: "text/markdown",
  fileSize: 256,
  createdAt: SAVED_TRANSCRIPT.createdAt,
  fragmentCount: 1,
  source: "learned",
  scope: "owner-private",
  provenance: { kind: "learned", label: "Voice transcript" },
  canEditText: true,
  canDelete: true,
  transcriptId: TRANSCRIPT_ID,
  transcriptAudioUrl: MEDIA_PATH,
  content: { text: TRANSCRIPT_TEXT },
};

/** Tracks the meaningful network proofs the tests assert on. */
interface TranscriptCreateProof {
  audioBase64Length: number;
  audioContentType: string | null;
  createdAtType: string;
  segmentCount: number;
  segmentTexts: string[];
}

interface TranscriptProbes {
  asrPostCount: number;
  asrMaxCapturedBytes: number;
  createBodies: TranscriptCreateProof[];
  updateCount: number;
  deleteCount: number;
}

function freshProbes(): TranscriptProbes {
  return {
    asrPostCount: 0,
    asrMaxCapturedBytes: 0,
    createBodies: [],
    updateCount: 0,
    deleteCount: 0,
  };
}

/**
 * Mock the ASR + transcript + media + knowledge backends. The ASR mock echoes the
 * captured-byte count so a test can prove a non-trivial WAV was recorded; the
 * /api/transcripts POST mock records the audioBase64 length so a test can prove
 * the REAL captured audio reached createTranscript.
 */
async function installTranscriptBackendMocks(
  page: Page,
  probes: TranscriptProbes,
): Promise<void> {
  await page.route("**/api/commands**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const surface = new URL(route.request().url()).searchParams.get("surface");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...TRANSCRIBE_COMMAND_CATALOG, surface }),
    });
  });

  // Conversation send path. Without a clean stream completion the optimistic
  // assistant bubble streams "thinking" dots forever and the auto-scroll keeps
  // the thread animating, so a transcript-attachment tile never settles for a
  // click. Returning a single conversation + a clean done event lets the turn
  // finish and the thread go static.
  const CONVO = {
    id: "transcript-convo",
    roomId: "transcript-room",
    title: "Transcript smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [CONVO] }),
      });
      return;
    }
    if (method === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation: CONVO }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/conversations/*", async (route) => {
    if (!["PATCH", "PUT"].includes(route.request().method())) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversation: CONVO }),
    });
  });
  // The post-turn history reload replaces the optimistic bubble with the server's
  // persisted messages. Serve a user turn that carries the transcript attachment
  // (linked to the saved record id) plus the assistant reply, so the transcript
  // tile PERSISTS across the reload (an empty list would wipe it and detach the
  // tile mid-click). The attachment uses the served `text/markdown` form the
  // server would persist — isTranscriptAttachment matches it via transcriptId.
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "user-transcript-msg",
            role: "user",
            // Non-empty text so the overlay's `visibleMessages` filter (which
            // drops empty-content turns) keeps this bubble — the tile rides on it.
            text: TRANSCRIPT_CAPTION,
            timestamp: SAVED_TRANSCRIPT.createdAt,
            attachments: [
              {
                id: "att-transcript-1",
                url: `/api/transcripts/${TRANSCRIPT_ID}/text`,
                contentType: "document",
                title: "Voice transcript.md",
                mimeType: "text/markdown",
                source: "client_chat",
                text: TRANSCRIPT_TEXT,
                transcriptId: TRANSCRIPT_ID,
              },
            ],
          },
          {
            id: "assistant-transcript-msg",
            role: "assistant",
            text: "Saved your transcript.",
            timestamp: SAVED_TRANSCRIPT.createdAt + 1000,
          },
        ],
      }),
    });
  });
  await page.route("**/api/conversations/*/messages/stream", async (route) => {
    const reply = "Saved your transcript.";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `data: ${JSON.stringify({ type: "token", text: reply, fullText: reply })}\n\n` +
        `data: ${JSON.stringify({ type: "done", fullText: reply, agentName: "Eliza" })}\n\n`,
    });
  });
  await page.route("**/api/conversations/*/greeting**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "Ready when you are.",
        localInference: null,
      }),
    });
  });

  await page.route("**/api/asr/local-inference/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    });
  });

  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataBuffer();
    const bytes = body?.byteLength ?? 0;
    probes.asrPostCount += 1;
    probes.asrMaxCapturedBytes = Math.max(probes.asrMaxCapturedBytes, bytes);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: bytes > 1000 ? TRANSCRIPT_TEXT : "",
        words:
          bytes > 1000
            ? [
                { text: "what", startMs: 0, endMs: 600 },
                { text: "time", startMs: 600, endMs: 1400 },
                { text: "is", startMs: 1400, endMs: 2000 },
                { text: "it", startMs: 2000, endMs: 3000 },
              ]
            : [],
        capturedBytes: bytes,
      }),
    });
  });

  // The transcript store. POST persists; GET list/detail; PUT edit; DELETE.
  // installDefaultAppRoutes registers a GET-only **/api/transcripts** empty-list
  // stub; registering AFTER it makes this win (last route wins) and we forward
  // GETs here so the Transcripts view + viewer load the seeded record.
  await page.route("**/api/transcripts", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const reqBody = route.request().postDataJSON() as {
        audioBase64?: string;
        audioContentType?: string;
        createdAt?: unknown;
        segments?: unknown[];
      };
      const segments = Array.isArray(reqBody?.segments) ? reqBody.segments : [];
      probes.createBodies.push({
        audioBase64Length: reqBody?.audioBase64?.length ?? 0,
        audioContentType:
          typeof reqBody?.audioContentType === "string"
            ? reqBody.audioContentType
            : null,
        createdAtType: typeof reqBody?.createdAt,
        segmentCount: segments.length,
        segmentTexts: segments
          .map((segment) =>
            segment && typeof segment === "object" && "text" in segment
              ? (segment as { text?: unknown }).text
              : null,
          )
          .filter((text): text is string => typeof text === "string"),
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ transcript: SAVED_TRANSCRIPT }),
      });
      return;
    }
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ transcripts: [SAVED_SUMMARY] }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/transcripts/${TRANSCRIPT_ID}`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ transcript: SAVED_TRANSCRIPT }),
      });
      return;
    }
    if (method === "PUT") {
      probes.updateCount += 1;
      const reqBody = route.request().postDataJSON() as {
        segments?: typeof SAVED_TRANSCRIPT.segments;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          transcript: {
            ...SAVED_TRANSCRIPT,
            segments: reqBody?.segments ?? SAVED_TRANSCRIPT.segments,
            editedAt: Date.now(),
          },
        }),
      });
      return;
    }
    if (method === "DELETE") {
      probes.deleteCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fallback();
  });

  // The served audio (viewer + Transcripts player <audio src>).
  const wav = tinyWav();
  await page.route(`**${MEDIA_PATH}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/wav", "accept-ranges": "bytes" },
      body: wav,
    });
  });

  // The Knowledge document mirroring the transcript — its DTO carries
  // transcriptId so the detail view shows the "View original transcript" link.
  // installDefaultAppRoutes registers a broad `**/api/documents**` returning a
  // default "Quarterly Plan.md" list; we must (a) use the same `**`-suffixed glob
  // so query-string requests match, and (b) register AFTER it (last route wins),
  // and (c) order our routes so the specific paths (stats / search / :id /
  // fragments) win over the list catch-all — Playwright checks routes in REVERSE
  // registration order, so the list goes first and the specific ones last.
  await page.route("**/api/documents**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== "GET" ||
      url.pathname !== "/api/documents"
    ) {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        available: true,
        agentId: "ui-smoke-agent",
        documents: [KNOWLEDGE_DOC],
        total: 1,
        limit: 100,
        offset: 0,
      }),
    });
  });
  await page.route("**/api/documents/stats**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        documentCount: 1,
        fragmentCount: 1,
        agentId: "ui-smoke-agent",
      }),
    });
  });
  await page.route("**/api/documents/search**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        query: url.searchParams.get("q") ?? "",
        threshold: 0.3,
        results: [],
        count: 0,
      }),
    });
  });
  await page.route(
    `**/api/documents/${KNOWLEDGE_DOC.id}/fragments**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documentId: KNOWLEDGE_DOC.id,
          fragments: [
            {
              id: "frag-1",
              text: TRANSCRIPT_TEXT,
              position: 0,
              createdAt: KNOWLEDGE_DOC.createdAt,
            },
          ],
          count: 1,
        }),
      });
    },
  );
  await page.route(`**/api/documents/${KNOWLEDGE_DOC.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ document: KNOWLEDGE_DOC }),
    });
  });
}

/** Count finished POSTs to the ASR endpoint (proof the capture chain ran). */
function trackAsrPosts(page: Page): { count: () => number } {
  let posted = 0;
  page.on("requestfinished", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    ) {
      posted += 1;
    }
  });
  return { count: () => posted };
}

async function toggleTranscriptionViaSlash(page: Page): Promise<void> {
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("/transcribe");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible({
    timeout: 15_000,
  });
  await composer.press("Enter");
  await expect(page.getByTestId("slash-command-menu")).toBeHidden({
    timeout: 15_000,
  });
  await expect(composer).toHaveValue("", { timeout: 15_000 });
}

async function startTranscriptionViaSlash(page: Page): Promise<void> {
  await toggleTranscriptionViaSlash(page);
  await expect(page.getByTestId("chat-transcribing-badge")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-composer-mic")).toHaveAttribute(
    "aria-label",
    "stop transcription and mic",
    { timeout: 15_000 },
  );
}

async function finalizeTranscriptionViaSlash(page: Page): Promise<void> {
  await toggleTranscriptionViaSlash(page);
  await expect(page.getByTestId("chat-transcribing-badge")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-composer-mic")).toHaveAttribute(
    "aria-label",
    "end conversation",
    { timeout: 15_000 },
  );
}

async function dispatchTranscriptionAgentAction(
  page: Page,
  command: "start" | "stop",
): Promise<void> {
  await page.evaluate((nextCommand) => {
    window.dispatchEvent(
      new CustomEvent("eliza:voice-control", {
        detail: { command: nextCommand },
      }),
    );
  }, command);
}

async function startTranscriptionViaAgentAction(page: Page): Promise<void> {
  await dispatchTranscriptionAgentAction(page, "start");
  // The agent-action bridge flips the shell controller directly; unlike the
  // slash-command path it may not expand the sheet far enough to render the
  // visible badge, so the mic control state is the durable proof.
  await expect(page.getByTestId("chat-composer-mic")).toHaveAttribute(
    "aria-label",
    "stop transcription and mic",
    { timeout: 15_000 },
  );
}

async function finalizeTranscriptionViaAgentAction(page: Page): Promise<void> {
  await dispatchTranscriptionAgentAction(page, "stop");
  await expect(page.getByTestId("chat-transcribing-badge")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-composer-mic")).toHaveAttribute(
    "aria-label",
    "end conversation",
    { timeout: 15_000 },
  );
}

/**
 * Turn voice fully OFF and wait for the chat thread to settle. While voice is on,
 * the hands-free re-listen loop continuously reopens the mic + streams interim
 * transcript text, which re-renders (and detaches) the thread bubbles — so a
 * transcript-attachment tile click races a re-mount. Tapping the mic when it is
 * the mic control (no draft/image AND not mid-recording) stops the loop; this
 * polls for that window, taps, and confirms the mic returns to "talk" (voice
 * off). Idempotent: returns immediately if voice is already off.
 */
async function stopVoiceAndSettle(page: Page): Promise<void> {
  const mic = page.getByTestId("chat-composer-mic");
  await expect
    .poll(
      async () => {
        // The mic only exists (vs the send button) when there's no pending
        // draft/image; during the re-listen loop it flickers between mic +
        // recording. Click it whenever it's present to toggle voice off.
        if ((await mic.count()) === 0) return false;
        const label = await mic.getAttribute("aria-label").catch(() => null);
        if (label === "talk") return true; // already off
        await mic.click({ timeout: 2000 }).catch(() => {});
        return (
          (await mic.getAttribute("aria-label").catch(() => null)) === "talk"
        );
      },
      { timeout: 20_000, intervals: [300] },
    )
    .toBe(true);
  await expect(mic).toHaveAttribute("aria-label", "talk", {
    timeout: 10_000,
  });
}

/**
 * Open the transcript viewer from the chat attachment tile, robust to the brief
 * thread remount the optimistic->persisted message swap causes. The viewer is a
 * child of the bubble's MessageAttachments; if that bubble remounts (the old
 * optimistic message id is replaced by the persisted one) the viewer closes. So
 * wait until the tile's box is stable across a short window (no pending remount),
 * THEN open it — and re-open if a late remount still closed it. Returns the
 * visible viewer locator.
 */
async function openTranscriptViewer(page: Page): Promise<Locator> {
  const viewer = page.getByTestId("transcript-viewer");
  const visibleTile = page
    .getByRole("button", { name: /Voice transcript\.md/i })
    .last();
  // The thread churns (auto-scroll + the optimistic->persisted swap), so the tile
  // can detach mid-click and a freshly-opened viewer can be torn down by a late
  // remount. Retry: click the currently visible tile in the DOM and confirm the
  // rich viewer content loaded; re-open if a remount closed it.
  await expect
    .poll(
      async () => {
        if (
          (await page
            .getByTestId("transcript-audio")
            .isVisible()
            .catch(() => false)) &&
          (await page
            .getByTestId("transcript-text")
            .isVisible()
            .catch(() => false))
        ) {
          // Confirm it survives a brief window (no pending remount-close).
          await page.waitForTimeout(600);
          if (
            (await viewer.isVisible().catch(() => false)) &&
            (await page
              .getByTestId("transcript-audio")
              .isVisible()
              .catch(() => false))
          ) {
            return true;
          }
        }
        if (await visibleTile.isVisible().catch(() => false)) {
          await visibleTile.click({ timeout: 1000 }).catch(async () => {
            await visibleTile.focus({ timeout: 1000 }).catch(() => {});
            await page.keyboard.press("Enter").catch(() => {});
          });
        }
        await page.evaluate((expectedTitle) => {
          const isVisible = (el: HTMLElement) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.pointerEvents !== "none"
            );
          };
          const tiles = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="transcript-attachment"]',
            ),
          );
          const tile =
            tiles.find(
              (el) => isVisible(el) && el.textContent?.includes(expectedTitle),
            ) ?? tiles.find(isVisible);
          tile?.click();
        }, "Voice transcript.md");
        return false;
      },
      { timeout: 45_000, intervals: [400] },
    )
    .toBe(true);
  await expect(viewer).toBeVisible({ timeout: 5_000 });
  return viewer;
}

/**
 * Drive the REAL transcript-capture chain from the chat overlay: tap mic ->
 * /transcribe -> (real audio captured + POSTed) -> /transcribe again to
 * finalize -> the transcript chip lands in the composer -> send -> the
 * transcript ATTACHMENT tile renders in the thread. Returns once the tile is
 * visible.
 */
async function captureTranscriptToAttachment(
  page: Page,
  probes: TranscriptProbes,
): Promise<void> {
  const asr = trackAsrPosts(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });

  await startTranscriptionViaSlash(page);

  await expect.poll(() => asr.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  await finalizeTranscriptionViaSlash(page);
  await expect
    .poll(
      () => probes.createBodies.find((b) => b.audioBase64Length > 1000) ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull();

  await expect(page.getByText(/^Transcript .*\.md$/).first()).toBeVisible({
    timeout: 15_000,
  });
  // Type a caption so the user turn has text (the overlay drops empty-content
  // turns from its thread, which would hide the tile-bearing bubble).
  await page.getByTestId("chat-composer-textarea").fill(TRANSCRIPT_CAPTION);
  // Send via the textarea Enter key (not the trailing button): while the
  // hands-free re-listen loop is live, that button oscillates between the mic
  // (recording) and the send action, so clicking it by testid races the morph.
  // Enter always submits the draft + the pending transcript attachment. Capture
  // the post-turn history-reload GET so we can wait for the optimistic->persisted
  // swap to finish — that swap remounts the bubble's MessageAttachments (and any
  // open viewer with it), so the tile must be the SETTLED persisted one.
  const reloaded = page.waitForResponse(
    (res) =>
      /\/api\/conversations\/[^/]+\/messages(?:\?|$)/.test(res.url()) &&
      res.request().method() === "GET" &&
      res.status() === 200,
    { timeout: 30_000 },
  );
  await page.getByTestId("chat-composer-textarea").press("Enter");
  // Stop the hands-free re-listen loop so the live-transcript overlay stops
  // re-rendering the thread; otherwise the attachment tile detaches mid-click.
  await stopVoiceAndSettle(page);
  // Wait for the turn to complete (clean stream done) so the assistant bubble
  // stops its "thinking" animation and the thread goes static, then the persisted
  // history (carrying the transcript attachment) renders the stable tile.
  await expect(page.getByText("Saved your transcript.").first()).toBeVisible({
    timeout: 30_000,
  });
  await reloaded.catch(() => {
    /* some flows don't reload; the optimistic tile is then already stable */
  });
  await expect(page.getByTestId("transcript-attachment").first()).toBeVisible({
    timeout: 20_000,
  });
}

async function prepareTranscriptTestPage(
  page: Page,
  probes: TranscriptProbes,
): Promise<void> {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await installTranscriptBackendMocks(page, probes);
}

type TranscriptionControlPath = "slash" | "agent-action";

function normalizeCreateProofForParity(proof: TranscriptCreateProof): {
  audioContentType: string | null;
  createdAtType: string;
  hasCapturedAudio: boolean;
  segmentCount: number;
  segmentTexts: string[];
} {
  return {
    audioContentType: proof.audioContentType,
    createdAtType: proof.createdAtType,
    hasCapturedAudio: proof.audioBase64Length > 1000,
    segmentCount: proof.segmentCount,
    segmentTexts: proof.segmentTexts,
  };
}

async function captureTranscriptRecordViaControlPath(
  page: Page,
  probes: TranscriptProbes,
  controlPath: TranscriptionControlPath,
): Promise<TranscriptCreateProof> {
  const asr = trackAsrPosts(page);

  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });

  if (controlPath === "agent-action") {
    await startTranscriptionViaAgentAction(page);
  } else {
    await startTranscriptionViaSlash(page);
  }

  await expect.poll(() => asr.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  if (controlPath === "agent-action") {
    await finalizeTranscriptionViaAgentAction(page);
  } else {
    await finalizeTranscriptionViaSlash(page);
  }

  await expect
    .poll(
      () => probes.createBodies.find((b) => b.audioBase64Length > 1000) ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull();

  await expect(page.getByText(/^Transcript .*\.md$/).first()).toBeVisible({
    timeout: 15_000,
  });

  const proof = probes.createBodies.find((b) => b.audioBase64Length > 1000);
  if (!proof) throw new Error("expected transcript create proof");
  return proof;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

test("REAL audio: /transcribe records the injected WAV, POSTs it to ASR + /api/transcripts, keeps the mic active, and drops a transcript attachment", async ({
  page,
}) => {
  const probes = freshProbes();
  await installTranscriptBackendMocks(page, probes);
  const asr = trackAsrPosts(page);

  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });

  // (LINKAGE a) Tap the mic FIRST -> hands-free -> the mic reads active.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });

  // (LINKAGE b) /transcribe -> transcription mode. The mic STAYS active
  // (transcript is an additive layer; the mic is the parent).
  await startTranscriptionViaSlash(page);
  // The mic button is still the active mic control while transcribing.
  await expect(mic).toHaveAttribute(
    "aria-label",
    "stop transcription and mic",
    {
      timeout: 15_000,
    },
  );

  // (REAL AUDIO) The transcription re-listen loop opens the REAL local-ASR
  // recorder against the fake device, WAV-encodes the injected audio, and POSTs
  // it to /api/asr/local-inference (VAD auto-stop drains + fires the POST).
  await expect
    .poll(() => asr.count(), {
      timeout: 30_000,
      message: "the transcription recorder must POST a captured WAV to ASR",
    })
    .toBeGreaterThan(0);
  expect(
    probes.asrMaxCapturedBytes,
    "the captured WAV POSTed to ASR must be a non-trivial recording",
  ).toBeGreaterThan(1000);

  // (REAL AUDIO + ATTACHMENT) Run /transcribe again to FINALIZE. The shell POSTs
  // the segments + the REAL captured audio (audioBase64) to /api/transcripts and
  // drops a `Transcript ….md` chip into the composer.
  await finalizeTranscriptionViaSlash(page);
  await expect
    .poll(
      () => probes.createBodies.find((b) => b.audioBase64Length > 1000) ?? null,
      {
        timeout: 30_000,
        message:
          "finalizing must POST the captured audio (audioBase64) to /api/transcripts",
      },
    )
    .not.toBeNull();
  const realCreate = probes.createBodies.find(
    (b) => b.audioBase64Length > 1000,
  );
  expect(realCreate?.segmentCount ?? 0).toBeGreaterThan(0);

  // (LINKAGE c) Transcript OFF leaves the mic ON. After finalize,
  // transcriptionMode is false and the hands-free parent loop resumes.
  await expect(mic).toHaveAttribute("aria-label", "end conversation", {
    timeout: 15_000,
  });

  // The finished transcript becomes a composer attachment chip (document kind).
  await expect(page.getByText(/^Transcript .*\.md$/).first()).toBeVisible({
    timeout: 15_000,
  });

  // (ATTACHMENT) Type a caption (so the tile-bearing user turn has text and isn't
  // dropped by the overlay's empty-turn filter), then send via the textarea Enter
  // key — robust against the trailing-button morph (mic<->send) while the
  // hands-free re-listen loop runs.
  await page.getByTestId("chat-composer-textarea").fill(TRANSCRIPT_CAPTION);
  await page.getByTestId("chat-composer-textarea").press("Enter");

  // (LINKAGE d) The mic is the master voice control: tapping it turns BOTH the
  // mic and transcript fully off. stopVoiceAndSettle taps the mic and asserts
  // the mic returns to "talk", stopping the re-listen loop so the thread
  // settles for the tile click below.
  await stopVoiceAndSettle(page);
  // Let the turn finish (clean stream done) so the assistant bubble stops
  // animating and the thread goes static, then the persisted history (carrying
  // the transcript attachment) renders the stable tile.
  await expect(page.getByText("Saved your transcript.").first()).toBeVisible({
    timeout: 30_000,
  });

  // (VIEWER, sanity) Open the maximized viewer from the now-stable tile (the
  // helper guards against the optimistic->persisted bubble remount) and confirm
  // the rich record loaded: served audio + the transcribed text.
  await openTranscriptViewer(page);
  await expect(page.getByTestId("transcript-audio")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("transcript-text")).toContainText(
    TRANSCRIPT_TEXT,
    { timeout: 15_000 },
  );
  await page.getByTestId("transcript-cancel").click();
  await expect(page.getByTestId("transcript-viewer")).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("VIEWER + LIVE MEETING + KNOWLEDGE: every transcript surface action works", async ({
  page,
}) => {
  const probes = freshProbes();
  await installTranscriptBackendMocks(page, probes);

  // Stub the clipboard + share/download seams so copy/share/save assert cleanly
  // without a real OS dialog.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __transcriptProbe: {
        copied: string | null;
        shared: number;
        downloads: number;
      };
    };
    w.__transcriptProbe = { copied: null, shared: 0, downloads: 0 };
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__transcriptProbe.copied = t;
            return Promise.resolve();
          },
        },
      });
    } catch {
      /* clipboard already defined — leave it */
    }
    (navigator as unknown as { share: (d: unknown) => Promise<void> }).share = (
      _d: unknown,
    ) => {
      w.__transcriptProbe.shared += 1;
      return Promise.resolve();
    };
    (navigator as unknown as { canShare: (d: unknown) => boolean }).canShare =
      () => true;
    // Count programmatic downloads (anchor.click on a generated href) without
    // navigating to blob:/media URLs in the test.
    HTMLAnchorElement.prototype.click = function patchedClick(
      this: HTMLAnchorElement,
    ) {
      if (this.download) w.__transcriptProbe.downloads += 1;
    };
  });

  const probe = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __transcriptProbe: {
              copied: string | null;
              shared: number;
              downloads: number;
            };
          }
        ).__transcriptProbe,
    );

  // /apps/transcripts is the live-meeting surface; stored recordings live in
  // Knowledge and retain inline playback in the viewer below.
  await openAppPath(page, "/apps/transcripts");
  await expect(page.getByTestId("live-meeting-page")).toBeVisible({
    timeout: 60_000,
  });

  // KNOWLEDGE: the mirrored document links back to the transcript. The
  // knowledge surface (DocumentsView) lives under the Character tab at
  // /character/documents (the /apps/documents path collides with a decomposed
  // PA view), rendered inside the CharacterEditor as <DocumentsView inModal />.
  await openAppPath(page, "/character/documents");
  await expect(page.getByTestId("documents-view")).toBeVisible({
    timeout: 60_000,
  });
  // Open the seeded knowledge document to show its detail, which renders the
  // back-link when the DTO has a transcriptId. The row is a button labelled
  // "Open {filename}" (full list) — fall back to any clickable element bearing
  // the filename text if the surface renders the compact chip variant.
  const docRow = page
    .getByTestId("documents-view")
    .getByRole("button", { name: /Voice transcript\.md/i })
    .first();
  await expect(docRow).toBeVisible({ timeout: 30_000 });
  await docRow.click();
  const knowledgeLink = page.getByTestId("document-open-transcript");
  await expect(knowledgeLink).toBeVisible({ timeout: 15_000 });
  await expect(knowledgeLink).toContainText(/View original transcript/i);

  // ── 4-VIEWER: drive the REAL chat tile -> viewer and exercise EVERY action ──
  await captureTranscriptToAttachment(page, probes);
  const viewer = await openTranscriptViewer(page);

  // Audio element has a real, served src.
  const viewerAudio = page.getByTestId("transcript-audio");
  await expect(viewerAudio).toBeVisible({ timeout: 15_000 });
  const viewerAudioSrc = await viewerAudio.getAttribute("src");
  expect(viewerAudioSrc).toMatch(/transcript-realaudio\.wav/);
  await expect(page.getByTestId("transcript-text")).toContainText(
    TRANSCRIPT_TEXT,
  );

  // Order matters: the only action that reflows the (flex-wrap) bar is Copy — it
  // flips its label "Copy"->"Copied"->"Copy" (1.5s), shifting later buttons. So
  // run every position-sensitive action FIRST while the bar is static (no `force`
  // needed), do Copy near the end, and Delete (which closes the viewer) last.

  // Edit -> type -> Undo restores the loaded text. Entering edit mode swaps the
  // <pre> for a tall (min-h-40vh) textarea, which grows the panel and shifts the
  // action bar — so scope the Undo button to the viewer and scroll it into view
  // before clicking, lest the click land on the full-screen close backdrop. The
  // loaded text is the speaker-labeled `transcriptPlainText` of the record's
  // segments ("Speaker 1: what time is it"), the exact value Undo restores.
  const loadedText = `${SAVED_TRANSCRIPT.segments[0].speakerLabel}: ${TRANSCRIPT_TEXT}`;
  await viewer.getByTestId("transcript-edit").click();
  const editor = page.getByTestId("transcript-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toHaveValue(loadedText, { timeout: 10_000 });
  await editor.fill(`${loadedText} EDITED`);
  await expect(editor).toHaveValue(`${loadedText} EDITED`);
  const undo = viewer.getByTestId("transcript-undo");
  await undo.scrollIntoViewIfNeeded();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(editor).toHaveValue(loadedText, { timeout: 10_000 });

  // Save text -> triggers a download (anchor with `download`).
  const dlBeforeText = (await probe()).downloads;
  await page.getByTestId("transcript-save-to-files").click();
  await expect
    .poll(async () => (await probe()).downloads)
    .toBeGreaterThan(dlBeforeText);

  // Share opens the permission sheet. The UI prepares an explicit agent-action
  // request, defaulting to redacted access instead of sharing raw transcript
  // text through the browser share sheet.
  const shareBefore = (await probe()).shared;
  await page.getByTestId("transcript-share").click();
  await expect(page.getByTestId("transcript-share-panel")).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    page.getByTestId("transcript-share-mode-redacted"),
  ).toBeVisible();
  await page.getByTestId("transcript-share-target").fill("viewer-entity");
  await page.getByTestId("transcript-share-prepare").click();
  await expect
    .poll(async () => (await probe()).shared)
    .toBeGreaterThan(shareBefore);
  await expect(page.getByTestId("transcript-share-notice")).toContainText(
    /agent still has to confirm|Request copied/i,
    { timeout: 5_000 },
  );

  // Copy -> writes the transcript text to the (stubbed) clipboard. Last of the
  // non-closing actions, because its label flip reflows the row.
  await page.getByTestId("transcript-copy").click();
  await expect
    .poll(async () => (await probe()).copied)
    .toContain(TRANSCRIPT_TEXT);

  // Delete is a two-tap confirm; the FIRST tap arms it (label -> "Confirm
  // delete"), the SECOND tap deletes (DELETE /api/transcripts/:id) and closes.
  // `force` guards against the residual "Copied"->"Copy" reflow above.
  const del = page.getByTestId("transcript-delete");
  await del.click({ force: true });
  await expect(del).toContainText(/Confirm delete/i, { timeout: 5_000 });
  await del.click({ force: true });
  await expect(viewer).toHaveCount(0, { timeout: 10_000 });
  expect(probes.deleteCount, "two-tap delete must DELETE the record").toBe(1);
});

test("VIEWER: open-in-knowledge navigates to the Knowledge view", async ({
  page,
}) => {
  const probes = freshProbes();
  await installTranscriptBackendMocks(page, probes);

  await captureTranscriptToAttachment(page, probes);
  await openTranscriptViewer(page);

  await page.getByTestId("transcript-open-in-knowledge").click();
  await expect(page.getByTestId("transcript-viewer")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("documents-view")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: /Voice transcript\.md/i }).first(),
  ).toBeVisible({ timeout: 15_000 });
});

// Scope note: this asserts CLIENT voice-control bridge parity — both paths drive
// the real useShellController transcription state machine, capture real WAV audio,
// POST real bytes to ASR, and produce a real /api/transcripts body that is then
// compared. The "agent-action" path is exercised at its last hop — the
// `eliza:voice-control` window event that the agent->shell bridge ultimately
// dispatches (startup-phase-hydrate's dispatchVoiceControl). It deliberately does
// NOT assert the upstream server START/STOP_TRANSCRIPTION action or the WS
// `agent_event{stream:"voice-control"}` envelope (there is no server-side
// voice-control emitter in the tree yet), so the title reflects bridge parity, not
// server-action coverage — see #9958 for the remaining server-side hop.
test("voice-control bridge parity: the eliza:voice-control bridge creates the same transcript record as the slash path", async ({
  browser,
}) => {
  const slashPage = await browser.newPage();
  const agentActionPage = await browser.newPage();
  try {
    const slashProbes = freshProbes();
    await prepareTranscriptTestPage(slashPage, slashProbes);
    const slashProof = await captureTranscriptRecordViaControlPath(
      slashPage,
      slashProbes,
      "slash",
    );

    const agentActionProbes = freshProbes();
    await prepareTranscriptTestPage(agentActionPage, agentActionProbes);
    const agentActionProof = await captureTranscriptRecordViaControlPath(
      agentActionPage,
      agentActionProbes,
      "agent-action",
    );

    expect(normalizeCreateProofForParity(agentActionProof)).toEqual(
      normalizeCreateProofForParity(slashProof),
    );
    expect(normalizeCreateProofForParity(agentActionProof)).toEqual({
      audioContentType: "audio/wav",
      createdAtType: "number",
      hasCapturedAudio: true,
      segmentCount: 1,
      segmentTexts: [TRANSCRIPT_TEXT],
    });
  } finally {
    await agentActionPage.close();
    await slashPage.close();
  }
});
