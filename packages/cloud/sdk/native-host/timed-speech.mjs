import { createHash, randomUUID } from "node:crypto";
import { NativeCloudServiceError } from "./errors.mjs";

const fail = (message, status = 502) =>
  new NativeCloudServiceError(message, { status });
const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_LINE = 12 * 1024 * 1024;
const MAX_WIRE = 24 * 1024 * 1024;
function alignment(value) {
  if (value === null) return null;
  const {
    characters,
    characterStartTimesSeconds: starts,
    characterEndTimesSeconds: ends,
  } = value ?? {};
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length > 50000 ||
    characters.length !== starts.length ||
    starts.length !== ends.length
  )
    throw fail("Invalid speech timing");
  for (let i = 0; i < characters.length; i++) {
    if (
      typeof characters[i] !== "string" ||
      !characters[i].length ||
      characters[i].length > 16 ||
      !Number.isFinite(starts[i]) ||
      !Number.isFinite(ends[i]) ||
      starts[i] < 0 ||
      ends[i] < starts[i] ||
      ends[i] > 3600 ||
      (i && (starts[i] < starts[i - 1] || ends[i] < ends[i - 1]))
    )
      throw fail("Invalid speech timing");
  }
  return {
    characters,
    characterStartTimesSeconds: starts,
    characterEndTimesSeconds: ends,
  };
}

/** Decode complete server frames across arbitrary network/UTF-8 boundaries. */
export async function* readTimedSpeech(response) {
  const mime = response.headers.get("content-type")?.split(";")[0];
  const legacy =
    mime === "audio/mpeg" && !response.headers.has("x-eliza-tts-timing");
  if (
    !response.body ||
    (!legacy &&
      (response.headers.get("x-eliza-tts-timing") !== "character-v1" ||
        mime !== "application/x-ndjson"))
  ) {
    await response.body?.cancel();
    throw fail("Timed speech is unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    wire = 0,
    audio = 0,
    sequence = 0,
    chars = 0,
    terminal = null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (legacy) {
          if (!audio) throw fail("Empty speech stream");
          yield { type: "done", frames: sequence, audioBytes: audio };
          return;
        }
        pending += decoder.decode();
        if (pending || !terminal) throw fail("Incomplete timed speech");
        yield terminal;
        return;
      }
      wire += chunk.value.byteLength;
      if (wire > MAX_WIRE) throw fail("Speech stream is too large");
      if (legacy) {
        audio += chunk.value.byteLength;
        if (audio > MAX_AUDIO || sequence >= 2048)
          throw fail("Speech stream is too large");
        if (chunk.value.byteLength)
          yield {
            type: "audio",
            sequence: sequence++,
            audioBase64: Buffer.from(chunk.value).toString("base64"),
            mimeType: "audio/mpeg",
            alignment: null,
            normalizedAlignment: null,
          };
        continue;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      for (
        let end = pending.indexOf("\n");
        end !== -1;
        end = pending.indexOf("\n")
      ) {
        if (end > MAX_LINE || terminal) throw fail("Invalid speech frame");
        let frame;
        try {
          frame = JSON.parse(pending.slice(0, end));
        } catch {
          throw fail("Invalid speech frame");
        }
        pending = pending.slice(end + 1);
        if (frame?.type === "done") {
          if (!audio || frame.frames !== sequence || frame.audioBytes !== audio)
            throw fail("Invalid speech completion");
          terminal = { type: "done", frames: sequence, audioBytes: audio };
          continue;
        }
        if (
          frame?.type !== "audio" ||
          frame.sequence !== sequence ||
          sequence >= 2048 ||
          frame.mimeType !== "audio/mpeg" ||
          typeof frame.audioBase64 !== "string" ||
          frame.audioBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.audioBase64)
        )
          throw fail("Invalid speech frame");
        const bytes = Buffer.from(frame.audioBase64, "base64");
        if (bytes.toString("base64") !== frame.audioBase64)
          throw fail("Invalid speech audio");
        audio += bytes.length;
        if (audio > MAX_AUDIO) throw fail("Speech audio is too large");
        const original = alignment(frame.alignment),
          normalized = alignment(frame.normalizedAlignment);
        chars +=
          (original?.characters.length ?? 0) +
          (normalized?.characters.length ?? 0);
        if (chars > 50000) throw fail("Speech timing is too large");
        yield {
          type: "audio",
          sequence: sequence++,
          audioBase64: frame.audioBase64,
          mimeType: "audio/mpeg",
          alignment: original,
          normalizedAlignment: normalized,
        };
      }
      if (pending.length > MAX_LINE) throw fail("Speech frame is too large");
    }
  } catch (error) {
    throw error instanceof NativeCloudServiceError
      ? error
      : fail("Speech stream failed");
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Read outcome already describes failure; cleanup never publishes provider data. */
    }
    reader.releaseLock();
  }
}

/** Ephemeral JSON bridge over a single provider stream. The host reads frames as
 * they arrive and keeps those the client has not acknowledged, so a lost pull reply
 * replays without synthesizing again. Pulling cursor N acknowledges frames before N.
 * A batch pull returns the frames ready after the cursor, up to maxBatchChars of
 * base64 audio. A finished stream keeps its unacknowledged audio for replayMs after
 * it finished or was last pulled, whichever is later. No credentials or audio are
 * persisted. */
export function createSpeechStreamSessions({
  open,
  assertOwner,
  now = () => performance.now(),
  lifetimeMs = 600000,
  // Keep replay identities for a sustained conversation, independently of the
  // two live provider streams. Completed sessions retain only terminal metadata.
  maxSessions = 256,
  maxActive = 2,
  // Keep a finished stream's unacknowledged audio this long after it finished
  // or was last pulled.
  replayMs = 30000,
  // Base64 audio characters in one batch reply; a batch always has one frame.
  maxBatchChars = 512 * 1024,
}) {
  const sessions = new Map(),
    requests = new Map();
  // A provider failure keeps the frames already read, so the client still gets them.
  function stop(session, state, keep = false) {
    if (state !== "failed" || !["cancelled", "expired"].includes(session.state))
      session.state = state;
    if (!keep) session.frames = [];
    if (!keep || session.state !== "failed") clearTimeout(session.idle);
    wake(session);
    const response = session.response,
      iterator = session.iterator;
    session.response = undefined;
    session.iterator = undefined;
    session.controller.abort();
    if (response?.body && !response.body.locked)
      void response.body.cancel().catch(() => {});
    void iterator?.return?.().catch(() => {});
  }
  function wake(session) {
    const resolve = session.wake;
    session.ready = new Promise((r) => {
      session.wake = r;
    });
    resolve?.();
  }
  async function read(session) {
    try {
      for (;;) {
        const result = await session.iterator.next();
        if (session.state !== "open") return;
        if (result.done) throw fail("Incomplete speech stream");
        session.frames.push(result.value);
        if (result.value.type === "done") {
          session.state = "done";
          finish(session);
          wake(session);
          await session.iterator.return();
          session.iterator = undefined;
          session.response = undefined;
          return;
        }
        wake(session);
      }
    } catch (error) {
      if (session.state === "done") return;
      if (session.state === "open")
        session.error =
          error instanceof NativeCloudServiceError
            ? error
            : fail("Speech stream unavailable");
      const failed = session.state === "open";
      stop(session, "failed", true);
      if (failed) finish(session);
    }
  }
  const finished = (s) => s.state === "done" || s.state === "failed";
  // Drop a finished stream's audio. A done stream keeps only its terminal frame.
  function trim(session) {
    const keep = session.state === "done" ? 1 : 0;
    if (!finished(session) || session.frames.length <= keep) return;
    session.base += session.frames.length - keep;
    session.frames = session.frames.slice(session.frames.length - keep);
  }
  // Restart the replay window; the timer trims even when no other call arrives.
  function touch(session) {
    session.touched = now();
    if (!finished(session)) return;
    clearTimeout(session.idle);
    session.idle = setTimeout(() => trim(session), replayMs);
    session.idle.unref?.();
  }
  function finish(session) {
    session.finished = now();
    touch(session);
  }
  // A stream holds audio the client has not received: it counts toward maxActive.
  const active = (s) =>
    s.state === "opening" ||
    s.state === "open" ||
    (finished(s) &&
      s.delivered === undefined &&
      s.frames.some((f) => f.type === "audio"));
  function sweep() {
    for (const [id, session] of sessions) {
      if (
        finished(session) &&
        now() >= Math.max(session.touched, session.finished) + replayMs
      )
        trim(session);
      if (now() >= session.expires) {
        stop(session, "expired");
        clearTimeout(session.timer);
        sessions.delete(id);
        requests.delete(session.requestId);
      }
    }
  }
  async function owned(id, owner) {
    sweep();
    const session = sessions.get(id);
    if (!session || session.owner !== owner)
      throw fail("Speech stream is unavailable", 410);
    await assertOwner(owner);
    if (session.owner !== owner || now() >= session.expires)
      throw fail("Speech stream expired", 410);
    return session;
  }
  return {
    async start({ requestId, owner, input }) {
      if (
        typeof requestId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)
      )
        throw fail("Invalid speech request identity", 400);
      sweep();
      await assertOwner(owner);
      const digest = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const existing = sessions.get(requests.get(requestId));
      if (existing) {
        if (
          existing.owner !== owner ||
          (existing.digest !== null && existing.digest !== digest)
        )
          throw fail("Speech request identity changed", 409);
        await existing.opening;
        await assertOwner(owner);
        return {
          streamId: existing.id,
          state: existing.state,
          renderedSpeed: existing.renderedSpeed,
        };
      }
      if (
        sessions.size >= maxSessions ||
        [...sessions.values()].filter(active).length >= maxActive
      )
        throw fail("Speech stream capacity reached", 429);
      const session = {
        id: randomUUID(),
        requestId,
        owner,
        digest,
        controller: new AbortController(),
        expires: now() + lifetimeMs,
        state: "opening",
        base: 0,
        frames: [],
        touched: now(),
        finished: now(),
        renderedSpeed: null,
        opening: null,
      };
      wake(session);
      sessions.set(session.id, session);
      requests.set(requestId, session.id);
      session.timer = setTimeout(() => stop(session, "expired"), lifetimeMs);
      session.timer.unref?.();
      session.opening = (async () => {
        try {
          const result = await open(input, session.controller.signal, owner);
          session.response = result.response;
          session.iterator = readTimedSpeech(result.response);
          session.renderedSpeed = result.renderedSpeed;
          await assertOwner(owner);
          if (session.state !== "opening" || session.controller.signal.aborted)
            throw fail("Speech stream stopped", 410);
          session.state = "open";
          void read(session);
        } catch (error) {
          stop(session, "failed");
          throw error instanceof NativeCloudServiceError
            ? error
            : fail("Speech stream unavailable");
        }
      })();
      await session.opening;
      return {
        streamId: session.id,
        state: session.state,
        renderedSpeed: session.renderedSpeed,
      };
    },
    async pull({ streamId, owner, cursor, batch = false }) {
      const session = await owned(streamId, owner);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw fail("Invalid speech cursor", 400);
      const unavailable = () =>
        session.error ?? fail("Speech stream cursor unavailable", 409);
      const end = session.base + session.frames.length;
      // A failed stream frees its audio once the client has all of it.
      if (cursor === end && session.state === "failed") {
        session.base = end;
        session.frames = [];
      }
      if (
        !["open", "done", "failed"].includes(session.state) ||
        cursor < session.base ||
        cursor > end ||
        (cursor === end && finished(session))
      )
        throw unavailable();
      // The client has every frame before its cursor.
      session.frames.splice(0, cursor - session.base);
      session.base = cursor;
      touch(session);
      while (!session.frames.length && session.state === "open")
        await session.ready;
      await assertOwner(owner);
      if (session.owner !== owner || now() >= session.expires)
        throw fail("Speech stream expired", 410);
      if (!["open", "done", "failed"].includes(session.state))
        throw session.error ?? fail("Speech stream stopped", 410);
      if (cursor !== session.base || !session.frames.length)
        throw unavailable();
      const frames = [session.frames[0]];
      let size = frames[0].audioBase64?.length ?? 0;
      for (let i = 1; batch && i < session.frames.length; i++) {
        size += session.frames[i].audioBase64?.length ?? 0;
        if (size > maxBatchChars) break;
        frames.push(session.frames[i]);
      }
      if (frames.at(-1).type === "done") session.delivered ??= now();
      return batch ? { cursor, frames } : { cursor, frame: frames[0] };
    },
    async cancel({ streamId, requestId, owner }) {
      if (requestId !== undefined) {
        if (
          streamId !== undefined ||
          typeof requestId !== "string" ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)
        )
          throw fail("Invalid speech cancellation", 400);
        sweep();
        await assertOwner(owner);
        streamId = requests.get(requestId);
        if (!streamId) {
          if (sessions.size >= maxSessions)
            throw fail("Speech stream capacity reached", 429);
          const session = {
            id: randomUUID(),
            requestId,
            owner,
            digest: null,
            controller: new AbortController(),
            expires: now() + lifetimeMs,
            state: "cancelled",
            base: 0,
            frames: [],
            renderedSpeed: null,
            opening: Promise.resolve(),
          };
          sessions.set(session.id, session);
          requests.set(requestId, session.id);
          session.timer = setTimeout(
            () => stop(session, "expired"),
            lifetimeMs,
          );
          session.timer.unref?.();
          return { state: "cancelled" };
        }
      }
      const session = await owned(streamId, owner);
      stop(session, "cancelled");
      return { state: "cancelled" };
    },
    cancelAll() {
      for (const session of sessions.values()) stop(session, "cancelled");
    },
    close() {
      for (const session of sessions.values()) {
        stop(session, "cancelled");
        clearTimeout(session.timer);
        clearTimeout(session.idle);
      }
      sessions.clear();
      requests.clear();
    },
  };
}
