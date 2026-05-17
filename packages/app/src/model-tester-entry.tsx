type TestStatus = {
  id: string;
  label: string;
  modelType: string;
  available: boolean;
  providers?: string[];
};

type AudioPayload = {
  audioDataUrl: string;
  pcmSamples: number[];
  sampleRateHz: number;
};

const tests = [
  "text-small",
  "text-large",
  "embedding",
  "text-to-speech",
  "transcription",
  "vad",
  "image-description",
  "image",
];

let statuses: TestStatus[] = [];
let imageDataUrl: string | null = null;
let audioPayload: AudioPayload | null = null;

document.body.innerHTML = `
  <style>
    :root { color-scheme: dark; font-family: "Poppins", "Open Sans", Arial, system-ui, sans-serif; background:#08090b; color:#f5f7fb; }
    body { margin:0; min-height:100vh; background:#08090b; }
    .shell { min-height:100vh; display:flex; flex-direction:column; }
    header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 18px; border-bottom:1px solid #242833; background:rgba(8,9,11,.92); backdrop-filter:blur(12px); }
    h1 { margin:0; font-size:17px; line-height:1.2; }
    .sub { margin-top:4px; color:#9ba3b4; font-size:12px; }
    button { border:1px solid #3a4050; background:#161a22; color:#f5f7fb; border-radius:8px; padding:8px 11px; font-weight:650; cursor:pointer; }
    button:hover { background:#202634; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    main { display:grid; grid-template-columns:minmax(260px,340px) 1fr; gap:16px; padding:16px; max-width:1400px; width:100%; box-sizing:border-box; margin:0 auto; }
    aside, section { border:1px solid #242833; background:#10131a; border-radius:8px; padding:14px; }
    textarea { width:100%; min-height:120px; box-sizing:border-box; resize:vertical; border:1px solid #343a48; border-radius:8px; background:#08090b; color:#f5f7fb; padding:10px; font:inherit; }
    label.file { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; border:1px solid #343a48; border-radius:8px; padding:11px; cursor:pointer; color:#dbe1ee; }
    input[type=file] { display:none; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    h2 { margin:0; font-size:14px; }
    .model { margin-top:7px; color:#9ba3b4; font:12px "Poppins", "Open Sans", Arial, system-ui, sans-serif; }
    .providers { margin-top:5px; color:#697286; font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
    .pill { border:1px solid #3a4050; color:#9ba3b4; border-radius:999px; padding:4px 8px; font-size:12px; white-space:nowrap; }
    .pill.ready { border-color:#277a55; color:#7be0af; background:#0f2a20; }
    pre { margin:12px 0 0; max-height:260px; overflow:auto; border:1px solid #242833; border-radius:8px; background:#08090b; color:#c5ccda; padding:10px; font:12px/1.45 "Poppins", "Open Sans", Arial, system-ui, sans-serif; white-space:pre-wrap; }
    audio, img.preview { margin-top:12px; width:100%; border-radius:8px; }
    img.preview { max-height:260px; object-fit:cover; border:1px solid #242833; }
    .error { color:#ff8b8b; font-size:12px; margin-top:10px; }
    @media (max-width: 860px) { main { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } }
  </style>
  <div class="shell">
    <header>
      <div><h1>Model Tester</h1><div class="sub">End-to-end Eliza-1 text, voice, audio, and vision probes</div></div>
      <div><button id="refresh">Refresh</button> <button id="run-all">Run all</button></div>
    </header>
    <main>
      <aside>
        <textarea id="prompt">Say exactly one short sentence about the Eliza-1 model tester working.</textarea>
        <label class="file">Image <span id="image-name">Choose image</span><input id="image-file" type="file" accept="image/*"></label>
        <label class="file">Audio <span id="audio-name">Choose audio</span><input id="audio-file" type="file" accept="audio/*"></label>
        <div id="asset-error" class="error"></div>
      </aside>
      <div id="cards" class="grid"></div>
    </main>
  </div>
`;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function audioFileToPayload(file: File): Promise<AudioPayload> {
  const audioDataUrl = await fileToDataUrl(file);
  const buffer = await file.arrayBuffer();
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(buffer.slice(0));
  const src = decoded.getChannelData(0);
  const targetRate = 16_000;
  const ratio = decoded.sampleRate / targetRate;
  const length = Math.min(targetRate * 15, Math.floor(src.length / ratio));
  const pcmSamples = Array.from(
    { length },
    (_, i) => src[Math.floor(i * ratio)] ?? 0,
  );
  await context.close();
  return { audioDataUrl, pcmSamples, sampleRateHz: targetRate };
}

function statusFor(id: string): TestStatus | undefined {
  return statuses.find((status) => status.id === id);
}

function renderCards(): void {
  el("cards").innerHTML = tests
    .map((id) => {
      const status = statusFor(id);
      return `<section id="card-${id}">
        <div class="card-head">
          <div><h2>${status?.label ?? id}</h2><div class="model">${status?.modelType ?? id}</div><div class="providers">${escapeHtml(status?.providers?.length ? status.providers.join(", ") : "no provider registered")}</div></div>
          <span class="pill ${status?.available || id === "vad" ? "ready" : ""}">${status?.available || id === "vad" ? "Ready" : "Missing"}</span>
        </div>
        <button data-run="${id}" style="margin-top:12px">Run</button>
        <div id="out-${id}"><pre>No output yet.</pre></div>
      </section>`;
    })
    .join("");
  document
    .querySelectorAll<HTMLButtonElement>("[data-run]")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => void runTest(button.dataset.run ?? ""),
      );
    });
}

function renderOutput(id: string, value: unknown): void {
  const box = el(`out-${id}`);
  const data = value as {
    ok?: boolean;
    output?: unknown;
    error?: string;
    durationMs?: number;
  };
  const output = data.ok ? data.output : data.error;
  const audio =
    data.ok && id === "text-to-speech" && output && typeof output === "object"
      ? `<audio controls src="data:${(output as { contentType?: string }).contentType ?? "audio/wav"};base64,${(output as { base64?: string }).base64 ?? ""}"></audio>`
      : "";
  const images =
    data.ok && id === "image" && output && typeof output === "object"
      ? ((output as { images?: Array<{ url?: string }> }).images ?? [])
          .map((img) =>
            img.url ? `<img class="preview" src="${img.url}" alt="">` : "",
          )
          .join("")
      : "";
  box.innerHTML = `${audio}${images}<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch,
  );
}

async function refresh(): Promise<void> {
  const response = await fetch("/api/model-tester/status");
  statuses = ((await response.json()) as { tests?: TestStatus[] }).tests ?? [];
  renderCards();
}

async function runTest(id: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-run="${id}"]`,
  );
  if (button) button.disabled = true;
  el(`out-${id}`).innerHTML = "<pre>Running...</pre>";
  try {
    const response = await fetch("/api/model-tester/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test: id,
        prompt: el<HTMLTextAreaElement>("prompt").value,
        imageDataUrl,
        audioDataUrl: audioPayload?.audioDataUrl,
        pcmSamples: audioPayload?.pcmSamples,
        sampleRateHz: audioPayload?.sampleRateHz,
      }),
    });
    renderOutput(id, await response.json());
  } catch (error) {
    renderOutput(id, {
      ok: false,
      test: id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (button) button.disabled = false;
  }
}

el("refresh").addEventListener("click", () => void refresh());
el("run-all").addEventListener("click", async () => {
  for (const id of tests) await runTest(id);
});
el<HTMLInputElement>("image-file").addEventListener("change", async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = (input.files ?? [])[0];
  if (!file) return;
  imageDataUrl = await fileToDataUrl(file);
  el("image-name").textContent = file.name;
});
el<HTMLInputElement>("audio-file").addEventListener("change", async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = (input.files ?? [])[0];
  if (!file) return;
  try {
    audioPayload = await audioFileToPayload(file);
    el("audio-name").textContent = file.name;
    el("asset-error").textContent = "";
  } catch (error) {
    el("asset-error").textContent =
      error instanceof Error ? error.message : String(error);
  }
});

void refresh();
