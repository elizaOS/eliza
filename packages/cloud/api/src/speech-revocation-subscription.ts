/** Subscribe once at bootstrap; losing the authoritative fence closes speech. */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { GenerativeRouteCaller } from "./lib/generative-route-auth";

export async function subscribeSpeechRevocation(
  env: AppEnv["Bindings"],
  caller: GenerativeRouteCaller,
  expiresAt: number,
  revoked: () => void,
): Promise<() => void> {
  if (!caller.credential || !env.INFERENCE_ADMISSION_GATES)
    throw Error("Verified speech revocation identity is unavailable");
  // This bounds the HTTP upgrade only. Aborting its signal after a 101 also
  // closes the healthy WebSocket and would falsely revoke active speech.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const response = await env.INFERENCE_ADMISSION_GATES.getByName(
    caller.user.organization_id,
  )
    .fetch("https://inference-admission.internal/speech/subscribe", {
      headers: {
        Upgrade: "websocket",
        "X-Eliza-Speech-Identity": JSON.stringify({
          organizationId: caller.user.organization_id,
          credential: caller.credential,
          expiresAt,
        }),
      },
      signal: controller.signal,
    })
    .finally(() => clearTimeout(timeout));
  const socket = response.webSocket;
  if (response.status !== 101 || !socket)
    throw Error("Speech revocation subscription was refused");
  socket.accept();
  let finished = false;
  let ready = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    try {
      socket.close(1000, "Speech fence closed");
    } catch {}
    revoked();
  };
  socket.addEventListener("close", stop);
  socket.addEventListener("error", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(Error("Speech revocation fence timed out")),
        3000,
      );
      const failed = () => {
        clearTimeout(deadline);
        reject(Error("Speech revocation fence closed"));
      };
      socket.addEventListener("close", failed, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("message", (event) => {
        clearTimeout(deadline);
        if (ready || event.data !== "ready") {
          stop();
          reject(Error("Invalid speech revocation fence"));
          return;
        }
        ready = true;
        resolve();
      });
    });
  } catch (error) {
    finished = true;
    socket.close(1000, "Speech subscription failed");
    throw error;
  }
  return () => {
    if (finished) return;
    finished = true;
    socket.close(1000, "Speech session ended");
  };
}
