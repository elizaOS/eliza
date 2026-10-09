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
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
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

/** Ephemeral JSON bridge over a single provider stream. One-frame replay absorbs
 * lost pull replies without synthesizing again. No credentials or audio are persisted. */
export function createSpeechStreamSessions({
  open,
  assertOwner,
  now = () => performance.now(),
  lifetimeMs = 600000,
  // Keep replay identities for a sustained conversation, independently of the
  // two live provider streams. Completed sessions retain only terminal metadata.
  maxSessions = 256,
  maxActive = 2,
}) {
  const sessions = new Map(),
    requests = new Map();
  function stop(session, state) {
    if (state !== "failed" || !["cancelled", "expired"].includes(session.state))
      session.state = state;
    session.last = null;
    const response = session.response,
      iterator = session.iterator;
    session.response = undefined;
    session.iterator = undefined;
    session.controller.abort();
    if (response?.body && !response.body.locked)
      void response.body.cancel().catch(() => {});
    void iterator?.return?.().catch(() => {});
  }
  function sweep() {
    for (const [id, session] of sessions)
      if (now() >= session.expires) {
        stop(session, "expired");
        clearTimeout(session.timer);
        sessions.delete(id);
        requests.delete(session.requestId);
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
        [...sessions.values()].filter(
          (s) => s.state === "opening" || s.state === "open",
        ).length >= maxActive
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
        cursor: 0,
        last: null,
        renderedSpeed: null,
        opening: null,
        pulling: null,
      };
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
    async pull({ streamId, owner, cursor }) {
      const session = await owned(streamId, owner);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw fail("Invalid speech cursor", 400);
      if (session.last?.cursor === cursor) return session.last;
      if (session.state !== "open" || cursor !== session.cursor)
        throw fail("Speech stream cursor unavailable", 409);
      if (!session.pulling)
        session.pulling = (async () => {
          try {
            const result = await session.iterator.next();
            await assertOwner(owner);
            if (
              session.state !== "open" ||
              session.controller.signal.aborted ||
              now() >= session.expires
            )
              throw fail("Speech stream stopped", 410);
            if (result.done) throw fail("Incomplete speech stream");
            session.last = { cursor, frame: result.value };
            session.cursor++;
            if (result.value.type === "done") {
              session.state = "done";
              await session.iterator.return();
              session.iterator = undefined;
              session.response = undefined;
            }
            return session.last;
          } catch (error) {
            stop(session, "failed");
            throw error instanceof NativeCloudServiceError
              ? error
              : fail("Speech stream unavailable");
          } finally {
            session.pulling = null;
          }
        })();
      return session.pulling;
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
            last: null,
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
      }
      sessions.clear();
      requests.clear();
    },
  };
}
