/**
 * In-browser `client` stand-in for the transcript deep-link `__e2e__` fixture
 * (#14806): a fixed knowledge dataset whose transcript audio is a REAL WAV
 * synthesized in-page (440/660 Hz tone, 3 s, 8 kHz PCM16) and served as a
 * `blob:` URL, so the reader's `<audio>` element loads real metadata and the
 * entry seek runs against a genuine media element — no app server. Only the
 * HTTP client boundary is faked; every component under DocumentsView is real.
 */

/** Synthesize a mono PCM16 WAV of `durationS` seconds and serve it as a blob URL. */
function synthWavBlobUrl(durationS: number, rate = 8000): string {
  const samples = Math.floor(durationS * rate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    // Two audibly-distinct halves so a human reviewing the video can HEAR that
    // playback starts in the second half after the deep-link seek.
    const freq = i / rate < 1.6 ? 440 : 660;
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000);
    view.setInt16(44 + i * 2, value, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

const wavUrl = synthWavBlobUrl(3);

const transcript = {
  id: "t-1",
  title: "Standup",
  createdAt: 1_700_000_000_000,
  durationMs: 3000,
  audioUrl: wavUrl,
  audioContentType: "audio/wav",
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 2,
  segments: [
    {
      id: "s1",
      speakerLabel: "Alice",
      startMs: 0,
      endMs: 1400,
      text: "hello there world",
      words: [
        { text: "hello", startMs: 0, endMs: 400 },
        { text: "there", startMs: 450, endMs: 900 },
        { text: "world", startMs: 950, endMs: 1400 },
      ],
    },
    {
      id: "s2",
      speakerLabel: "Bob",
      startMs: 1600,
      endMs: 3000,
      text: "this is a timestamp test",
      words: [
        { text: "this", startMs: 1600, endMs: 1800 },
        { text: "is", startMs: 1850, endMs: 2000 },
        { text: "a", startMs: 2050, endMs: 2150 },
        { text: "timestamp", startMs: 2200, endMs: 2650 },
        { text: "test", startMs: 2700, endMs: 3000 },
      ],
    },
  ],
};

const document_ = {
  id: "doc-t",
  filename: "standup.txt",
  contentType: "text/plain",
  fileSize: 64,
  createdAt: 1_700_000_000_000,
  fragmentCount: 2,
  source: "transcript",
  provenance: { kind: "runtime", label: "Transcript" },
  canEditText: false,
  canDelete: true,
  content: {
    text: "Alice: hello there world\nBob: this is a timestamp test",
  },
  transcriptId: "t-1",
  transcriptAudioUrl: wavUrl,
};

const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  listDocuments: async () => ({ documents: [], total: 0 }),
  getDocumentFacetCounts: async () => ({
    counts: { all: 1, doc: 0, image: 0, audio: 0, video: 0, transcript: 1 },
  }),
  searchDocuments: async () => ({
    query: "timestamp",
    threshold: 0.3,
    count: 2,
    results: [
      {
        id: "frag-anchored",
        text: "Bob: this is a timestamp test",
        similarity: 0.91,
        documentId: "doc-t",
        documentTitle: "standup",
        position: 1,
        transcriptId: "t-1",
        startMs: 1600,
        endMs: 3000,
      },
      {
        id: "frag-plain",
        text: "plain document chunk with no transcript anchors",
        similarity: 0.78,
        documentId: "doc-t",
        documentTitle: "notes",
        position: 0,
      },
    ],
  }),
  getDocument: async () => ({ document: document_ }),
  getDocumentFragments: async () => ({
    documentId: "doc-t",
    fragments: [
      {
        id: "frag-plain",
        text: "Alice: hello there world",
        position: 0,
        createdAt: 1_700_000_000_000,
      },
      {
        id: "frag-anchored",
        text: "Bob: this is a timestamp test",
        position: 1,
        createdAt: 1_700_000_000_000,
      },
    ],
    count: 2,
  }),
  getTranscript: async () => ({ transcript }),
};

/** Unstubbed client calls resolve quietly so an incidental fetch never wedges the fixture. */
export const client = new Proxy(methods, {
  get: (target, prop: string) =>
    prop in target ? target[prop] : async () => ({}),
});
