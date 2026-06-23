// Standalone Eliza-1 (Gemma-4) model downloader via the LocalInferenceService facade.
import { localInferenceService } from "@elizaos/plugin-local-inference/services";

const id = process.argv[2] || "eliza-1-2b";
const gb = (n) => (Number(n) / 1e9).toFixed(2);

console.log(`startDownload: ${id}`);
let job;
try {
  job = await localInferenceService.startDownload(id);
  console.log(`job: ${JSON.stringify(job)}`);
} catch (e) {
  console.log(`START_ERROR: ${e?.message || e}`);
  process.exit(2);
}

let last = 0;
while (true) {
  let list = [];
  try {
    const d = await localInferenceService.getDownloads();
    list = Array.isArray(d) ? d : (d?.downloads ?? d?.jobs ?? []);
  } catch (e) {
    console.log(`getDownloads err: ${e?.message || e}`);
  }
  const j = list.find((x) => x.modelId === id) || list[0];
  if (j) {
    const terminal = ["completed", "failed", "cancelled"].includes(j.state);
    const now = Date.now();
    if (terminal || now - last > 4000) {
      last = now;
      const pct = j.total ? ((j.received / j.total) * 100).toFixed(1) : "?";
      console.log(
        `[${j.state}] ${pct}% ${gb(j.received)}/${gb(j.total)}GB ${j.error || ""}`,
      );
    }
    if (terminal) {
      console.log(`FINAL: ${j.state} ${j.error || ""}`);
      process.exit(j.state === "completed" ? 0 : 1);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
