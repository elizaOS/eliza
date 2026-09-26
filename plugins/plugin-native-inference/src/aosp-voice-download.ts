import {
  type AospNetworkAdmissionOptions,
  createAospNetworkAdmissionCheck,
} from "./aosp-network-admission.js";
import { downloadHttpModel } from "./shared/http-model-download.js";

const REVISION = "1e4c73713e11f7ff42bc2a686cc5b178c8cac14f";
export const AOSP_KOKORO_ASSETS = [
  {
    name: "kokoro-82m-v1_0.gguf",
    path: "bundles/e2b/tts/kokoro/kokoro-82m-v1_0.gguf",
    sha256: "165acd9d2d9b6c2d71fa5bd52b92a2559be08567f58ed496bade076e3d9cb46c",
    sizeBytes: 162546720,
  },
  {
    name: "af_sam.bin",
    path: "voice/kokoro/voices/af_sam.bin",
    sha256: "6874670865ce984a5400afc87176706c5ed88671999c59ed0dff5dcde664277b",
    sizeBytes: 522240,
  },
].map((asset) => ({
  ...asset,
  url: `https://huggingface.co/elizaos/eliza-1/resolve/${REVISION}/${asset.path}`,
}));

/** Verified files enter the caller-owned staging directory before its atomic bundle publication. */
export async function downloadAospVoiceAsset(
  asset: { url: string; sha256: string; sizeBytes: number },
  destination: string,
  options: AospNetworkAdmissionOptions & { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await downloadHttpModel({
    url: asset.url,
    stagingPath: `${destination}.part`,
    finalPath: destination,
    label: "Automatic voice artifact",
    expectedSizeBytes: asset.sizeBytes,
    expectedSha256: asset.sha256,
    checkAdmission: createAospNetworkAdmissionCheck(asset.sizeBytes, options),
    fetchImpl: options.fetchImpl,
  });
}
