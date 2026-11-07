/** Streaming ASR sessions behind the bionic inference host's asr_stream_* ops. */
package ai.elizaos.app;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Streaming ASR over the bionic UDS (Phonon-2 / parakeet backend, ABI 18).
 *
 * <p>Protocol, one JSON request frame and one JSON response frame per op, on a
 * connection the client keeps open for the whole stream:
 * <pre>
 *   asr_stream_supported {bundleDir}             -> {ok, supported}
 *   asr_stream_open      {bundleDir, sampleRate} -> {ok, streamId, sampleRate}
 *                                                  | {ok:false, code:"STREAM_UNSUPPORTED"}
 *   asr_stream_feed      {pcmBase64}             -> {ok, samples, totalSamples}
 *   asr_stream_partial   {}                      -> {ok, text}
 *   asr_stream_finish    {}                      -> {ok, text}
 *   asr_stream_close     {}                      -> {ok, closed}
 *   asr_stream_cancel    {streamId}              -> {ok, signalled}   (any connection)
 * </pre>
 * A connection owns at most one stream. feed/partial/finish/close act on that
 * stream. cancel names the stream by id, so it can be sent on a second
 * connection while partial/finish decodes on the first; the decode then
 * answers {@code code:"CANCELLED"}. When the owning connection closes, its
 * stream is cancelled and freed.
 *
 * <p>Bounds: one feed carries at most {@link #MAX_FEED_SECONDS} of audio, a
 * stream at most {@link #MAX_STREAM_SECONDS}, and the host holds at most
 * {@link #MAX_STREAMS} streams. The native transcript buffer is 64 KiB.
 *
 * <p>Locking: the caller holds the server's resident lock for every method
 * except {@link #cancel}, and destroys the native context only after
 * {@link #closeAll}. {@link #cancel} only takes the session monitor, which
 * close also takes, so it never signals a freed stream.
 *
 * <p>Logs carry sample counts and transcript lengths only, never text.
 */
final class BionicAsrStreams {

    /** The JNI calls, behind an interface so the protocol is testable on the host. */
    interface Native {
        /** Acquire the context's "asr" region; 1 when it streams (parakeet backend). */
        int supported(long ctx);

        /** Open a stream. Throws IllegalArgumentException when the backend cannot stream. */
        long open(long ctx, int sampleRate);

        int feed(long stream, float[] pcm);

        String partial(long stream);

        String finish(long stream);

        void cancel(long stream);

        void close(long stream);
    }

    /** Minimal logger so the class does not depend on android.util.Log. */
    interface Logger {
        void info(String message);
    }

    static final int MAX_STREAMS = 4;
    static final int MAX_FEED_SECONDS = 5;
    static final int MAX_STREAM_SECONDS = 120;
    static final int MIN_SAMPLE_RATE = 8000;
    static final int MAX_SAMPLE_RATE = 48000;

    /** One open stream. {@code closed} and native close/cancel are guarded by the session monitor. */
    static final class Session {
        final String id;
        final long handle;
        final int sampleRate;
        long fedSamples;
        boolean finished;
        boolean closed;

        Session(String id, long handle, int sampleRate) {
            this.id = id;
            this.handle = handle;
            this.sampleRate = sampleRate;
        }
    }

    /** Per-connection state: the one stream this client owns, if any. */
    static final class Client {
        Session session;
    }

    private final Native nativeApi;
    private final Logger log;
    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    BionicAsrStreams(Native nativeApi, Logger log) {
        this.nativeApi = nativeApi;
        this.log = log;
    }

    static boolean isStreamOp(String op) {
        return op != null && op.startsWith("asr_stream_");
    }

    int openCount() {
        return sessions.size();
    }

    /** Supplies the resident native context (creating it on demand). */
    interface ContextSupplier {
        long get();
    }

    /**
     * Handle every stream op except cancel. The caller holds the resident lock.
     * Native failures other than cancel/rejection propagate so the server can
     * reset its context; the session is closed first.
     */
    String handle(Client client, String op, JSONObject req, ContextSupplier ctx) throws JSONException {
        // closeAll (context reset, region evict) frees streams under their
        // owners; forget such a stream so no op reaches a freed handle.
        final Session owned = client.session;
        if (owned != null) {
            synchronized (owned) {
                if (owned.closed) client.session = null;
            }
        }
        switch (op) {
            case "asr_stream_supported": {
                final long c = ctx.get();
                try {
                    return ok().put("supported", nativeApi.supported(c) == 1).toString();
                } catch (RuntimeException unavailable) {
                    // No loadable asr/ region: neither streaming nor batch can run.
                    return error("asr_stream_supported: ASR region unavailable", "ASR_UNAVAILABLE");
                }
            }
            case "asr_stream_open":
                return open(client, req, ctx);
            case "asr_stream_feed":
                return feed(client, req);
            case "asr_stream_partial":
                return decode(client, false);
            case "asr_stream_finish":
                return decode(client, true);
            case "asr_stream_close": {
                final boolean had = client.session != null;
                closeClient(client);
                return ok().put("closed", had).toString();
            }
            default:
                return error("unsupported op: " + op, null);
        }
    }

    private String open(Client client, JSONObject req, ContextSupplier ctx) throws JSONException {
        if (client.session != null) {
            return error("asr_stream_open: this connection already has an open stream", "STREAM_BUSY");
        }
        final int sampleRate = req.optInt("sampleRate", 16000);
        if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
            return error("asr_stream_open: sampleRate must be " + MIN_SAMPLE_RATE + ".."
                + MAX_SAMPLE_RATE + " Hz", null);
        }
        if (sessions.size() >= MAX_STREAMS) {
            return error("asr_stream_open: " + MAX_STREAMS + " streams already open", "STREAM_BUSY");
        }
        final long handle;
        try {
            handle = nativeApi.open(ctx.get(), sampleRate);
        } catch (IllegalArgumentException notStreaming) {
            // The library has no parakeet backend loaded (a build without
            // Parakeet-TDT). The client falls back to op="asr".
            log.info("ASR stream unsupported by the loaded backend");
            return error("asr_stream_open: the loaded ASR backend does not stream", "STREAM_UNSUPPORTED");
        }
        if (handle == 0L) {
            return error("asr_stream_open: native open returned no stream", null);
        }
        final Session session = new Session(newId(), handle, sampleRate);
        sessions.put(session.id, session);
        client.session = session;
        log.info("ASR stream open @ " + sampleRate + " Hz (" + sessions.size() + " open)");
        return ok().put("streamId", session.id).put("sampleRate", sampleRate).toString();
    }

    private String feed(Client client, JSONObject req) throws JSONException {
        final Session s = client.session;
        if (s == null) return error("asr_stream_feed: no open stream (closed or never opened)", "NO_STREAM");
        if (s.finished) return error("asr_stream_feed: stream already finished", null);
        final float[] pcm;
        try {
            pcm = decodePcm(req.optString("pcmBase64", ""));
        } catch (IllegalArgumentException bad) {
            return error("asr_stream_feed: " + bad.getMessage(), null);
        }
        if (pcm.length == 0) {
            return ok().put("samples", 0).put("totalSamples", s.fedSamples).toString();
        }
        if (pcm.length > (long) MAX_FEED_SECONDS * s.sampleRate) {
            return error("asr_stream_feed: one feed may carry at most " + MAX_FEED_SECONDS + " s", "FEED_TOO_LARGE");
        }
        if (s.fedSamples + pcm.length > (long) MAX_STREAM_SECONDS * s.sampleRate) {
            return error("asr_stream_feed: stream exceeds " + MAX_STREAM_SECONDS + " s", "STREAM_TOO_LONG");
        }
        final int consumed = nativeApi.feed(s.handle, pcm);
        s.fedSamples += Math.max(0, consumed);
        return ok().put("samples", consumed).put("totalSamples", s.fedSamples).toString();
    }

    private String decode(Client client, boolean finish) throws JSONException {
        final String op = finish ? "asr_stream_finish" : "asr_stream_partial";
        final Session s = client.session;
        if (s == null) return error(op + ": no open stream", "NO_STREAM");
        if (s.finished) return error(op + ": stream already finished", null);
        final long started = System.nanoTime();
        final String text;
        try {
            text = finish ? nativeApi.finish(s.handle) : nativeApi.partial(s.handle);
        } catch (CancellationException cancelled) {
            log.info("ASR stream " + (finish ? "finish" : "partial") + " cancelled after "
                + s.fedSamples + " samples");
            return error(op + " cancelled", "CANCELLED");
        } catch (IllegalArgumentException rejected) {
            // Evicted region or a closed decoder: the stream cannot continue.
            closeClient(client);
            return error(op + ": stream rejected by the native decoder", "STREAM_CLOSED");
        } catch (RuntimeException fault) {
            closeClient(client);
            throw fault;
        }
        if (finish) s.finished = true;
        final long ms = (System.nanoTime() - started) / 1_000_000L;
        final String safe = text == null ? "" : text;
        log.info("ASR stream " + (finish ? "final" : "partial") + ": " + s.fedSamples
            + " samples -> " + safe.length() + " chars in " + ms + " ms");
        return ok().put("text", safe).put("ms", ms).toString();
    }

    /** Signal a running partial/finish on stream {@code id}. No resident lock needed. */
    String cancel(String id) throws JSONException {
        final Session s = id == null ? null : sessions.get(id);
        if (s == null) return ok().put("signalled", false).toString();
        synchronized (s) {
            if (s.closed) return ok().put("signalled", false).toString();
            nativeApi.cancel(s.handle);
        }
        return ok().put("signalled", true).toString();
    }

    /** Cancel and free the client's stream (disconnect or explicit close). Caller holds the resident lock. */
    void closeClient(Client client) {
        final Session s = client.session;
        client.session = null;
        if (s != null) closeSession(s);
    }

    /**
     * Free every stream before the native context is destroyed or its "asr"
     * region evicted. Owning connections see {@code NO_STREAM} on their next op.
     */
    void closeAll(String reason) {
        final List<Session> all = new ArrayList<>(sessions.values());
        for (Session s : all) closeSession(s);
        if (!all.isEmpty()) log.info("closed " + all.size() + " ASR stream(s): " + reason);
    }

    private void closeSession(Session s) {
        sessions.remove(s.id);
        synchronized (s) {
            if (s.closed) return;
            s.closed = true;
            try {
                nativeApi.cancel(s.handle);
            } catch (RuntimeException ignored) {
                // Nothing is decoding on a stream being closed; cancel only clears state.
            }
            nativeApi.close(s.handle);
        }
    }

    /** Base64 little-endian fp32 PCM to floats; rejects ragged or non-finite input. */
    static float[] decodePcm(String pcmBase64) {
        if (pcmBase64 == null || pcmBase64.isEmpty()) return new float[0];
        final byte[] raw;
        try {
            raw = Base64.getMimeDecoder().decode(pcmBase64);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("pcmBase64 is not base64");
        }
        if (raw.length % 4 != 0) {
            throw new IllegalArgumentException("pcmBase64 decoded to " + raw.length + " bytes (need fp32 PCM)");
        }
        final float[] pcm = new float[raw.length / 4];
        final ByteBuffer bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < pcm.length; i++) {
            final float v = bb.getFloat();
            if (!Float.isFinite(v)) throw new IllegalArgumentException("non-finite sample at " + i);
            pcm[i] = v;
        }
        return pcm;
    }

    private String newId() {
        final byte[] b = new byte[12];
        random.nextBytes(b);
        final StringBuilder sb = new StringBuilder(24);
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    private static JSONObject ok() throws JSONException {
        return new JSONObject().put("ok", true);
    }

    private static String error(String message, String code) throws JSONException {
        final JSONObject o = new JSONObject().put("ok", false).put("error", message);
        if (code != null) o.put("code", code);
        return o.toString();
    }
}
