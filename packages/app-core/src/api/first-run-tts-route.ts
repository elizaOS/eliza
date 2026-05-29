import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCompatJsonBody } from "./compat-route-shared";
import { isOnboardingVoiceLineId } from "./onboarding-voice-lines";
import { sendJson as sendJsonResponse } from "./response";

export interface FirstRunTtsRouteDeps {
  /**
   * Read the pre-generated preset audio (WAV) for a validated onboarding line
   * id. Returns `null` when the preset has not been generated yet.
   */
  readPreset: (lineId: string) => Buffer | null;
}

function resolveOnboardingVoiceDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "assets", "onboarding-voice");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Source-tree fallback (`src/api` -> package root); reads return null until
  // the dir/presets exist.
  return path.resolve(moduleDir, "../../assets/onboarding-voice");
}

const defaultDeps: FirstRunTtsRouteDeps = {
  readPreset: (lineId) => {
    const file = path.join(resolveOnboardingVoiceDir(), `${lineId}.wav`);
    return existsSync(file) ? readFileSync(file) : null;
  },
};

/**
 * Onboarding TTS: serve a pre-generated OmniVoice preset for a fixed first-run
 * line. The audio is generated once by our default local voice model and
 * committed as a bundled WAV (onboarding runs before any agent or downloaded
 * model exists), so playback is instant and offline.
 *
 * `404` means the preset is not generated yet; the client falls back to browser
 * speech synthesis so onboarding never goes silent.
 */
export async function handleFirstRunTtsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FirstRunTtsRouteDeps = defaultDeps,
): Promise<boolean> {
  const body = await readCompatJsonBody(req, res);
  if (!body || typeof body !== "object") return true;

  const lineId = (body as { lineId?: unknown }).lineId;
  if (!isOnboardingVoiceLineId(lineId)) {
    sendJsonResponse(res, 400, { error: "Unknown onboarding line id" });
    return true;
  }

  const audio = deps.readPreset(lineId);
  if (!audio) {
    sendJsonResponse(res, 404, { error: "Preset not generated" });
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Cache-Control": "no-store",
    "Content-Length": String(audio.byteLength),
  });
  res.end(audio);
  return true;
}
