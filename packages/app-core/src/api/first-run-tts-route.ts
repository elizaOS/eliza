import type http from "node:http";
import { readCompatJsonBody } from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";

export interface FirstRunTtsRouteDeps {
  /** Synthesize speech bytes for the given text and optional voice id. */
  synthesize: (text: string, voice?: string) => Promise<Buffer>;
}

const defaultDeps: FirstRunTtsRouteDeps = {
  synthesize: async (text, voice) => {
    const { synthesizeEdgeSpeech } = await import("@elizaos/plugin-edge-tts");
    return synthesizeEdgeSpeech(text, voice ? { voice } : {});
  },
};

/**
 * Onboarding TTS: synthesize a fixed first-run script line with edge-tts
 * (free, no-key neural voice) before any agent exists. edge-tts is imported
 * dynamically so app-core keeps no static dependency on a plugin package.
 */
export async function handleFirstRunTtsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FirstRunTtsRouteDeps = defaultDeps,
): Promise<boolean> {
  const body = await readCompatJsonBody(req, res);
  if (!body || typeof body !== "object") return true;

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    sendJsonResponse(res, 400, { error: "Missing text" });
    return true;
  }

  const voice =
    typeof body.voice === "string" && body.voice.trim()
      ? body.voice.trim()
      : undefined;

  try {
    const audio = await deps.synthesize(text, voice);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "Content-Length": String(audio.byteLength),
    });
    res.end(audio);
  } catch (err) {
    sendJsonResponse(res, 502, {
      error: `first-run TTS error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return true;
}
