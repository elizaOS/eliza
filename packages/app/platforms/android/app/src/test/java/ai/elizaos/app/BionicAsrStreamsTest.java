package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CancellationException;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Protocol tests for the bionic host's streaming ASR ops. The fake stands in
 * for the JNI calls only; the unit under test is the op dispatch, the bounds,
 * one-stream-per-connection, cancel by id, close on disconnect, and that logs
 * never carry transcript text.
 */
public final class BionicAsrStreamsTest {

    private static final long CTX = 0x1000L;

    private static final class FakeNative implements BionicAsrStreams.Native {
        boolean streaming = true;
        long nextHandle = 7;
        final List<Long> open = new ArrayList<>();
        final List<Long> closed = new ArrayList<>();
        final List<Long> cancelled = new ArrayList<>();
        long fed;
        boolean cancelNextDecode;
        RuntimeException faultOnPartial;

        @Override public int supported(long ctx) { return streaming ? 1 : 0; }

        @Override public long open(long ctx, int sampleRate) {
            assertEquals(CTX, ctx);
            if (!streaming) throw new IllegalArgumentException("not parakeet");
            final long h = nextHandle++;
            open.add(h);
            return h;
        }

        @Override public int feed(long stream, float[] pcm) {
            fed += pcm.length;
            return pcm.length;
        }

        @Override public String partial(long stream) {
            if (faultOnPartial != null) throw faultOnPartial;
            if (cancelNextDecode) {
                cancelNextDecode = false;
                throw new CancellationException("cancelled");
            }
            return "secret words " + fed;
        }

        @Override public String finish(long stream) { return "secret final " + fed; }

        @Override public void cancel(long stream) { cancelled.add(stream); }

        @Override public void close(long stream) {
            closed.add(stream);
            open.remove(Long.valueOf(stream));
        }
    }

    private final FakeNative fake = new FakeNative();
    private final List<String> logs = new ArrayList<>();
    private final BionicAsrStreams streams = new BionicAsrStreams(fake, logs::add);

    private JSONObject call(BionicAsrStreams.Client client, String op, JSONObject req) throws Exception {
        return new JSONObject(streams.handle(client, op, req.put("op", op), () -> CTX));
    }

    private JSONObject call(BionicAsrStreams.Client client, String op) throws Exception {
        return call(client, op, new JSONObject());
    }

    private static String pcm(int samples) {
        final ByteBuffer bb = ByteBuffer.allocate(samples * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < samples; i++) bb.putFloat((float) Math.sin(i * 0.01));
        return Base64.getEncoder().encodeToString(bb.array());
    }

    @Test
    public void fullStreamLifecycle() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        assertTrue(call(c, "asr_stream_supported").getBoolean("supported"));
        final JSONObject opened = call(c, "asr_stream_open", new JSONObject().put("sampleRate", 16000));
        assertTrue(opened.getBoolean("ok"));
        final String id = opened.getString("streamId");
        assertEquals(24, id.length());
        final JSONObject fed = call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", pcm(1600)));
        assertEquals(1600, fed.getInt("samples"));
        assertEquals(1600, fed.getLong("totalSamples"));
        assertEquals("secret words 1600", call(c, "asr_stream_partial").getString("text"));
        assertEquals("secret final 1600", call(c, "asr_stream_finish").getString("text"));
        final JSONObject late = call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", pcm(10)));
        assertFalse(late.getBoolean("ok"));
        assertTrue(call(c, "asr_stream_close").getBoolean("closed"));
        assertEquals(0, streams.openCount());
        assertTrue(fake.open.isEmpty());
        for (String line : logs) {
            assertFalse("logs must not carry transcript text: " + line, line.contains("secret"));
        }
    }

    @Test
    public void unsupportedBackendAnswersStreamUnsupported() throws Exception {
        fake.streaming = false;
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        assertFalse(call(c, "asr_stream_supported").getBoolean("supported"));
        final JSONObject r = call(c, "asr_stream_open", new JSONObject().put("sampleRate", 16000));
        assertFalse(r.getBoolean("ok"));
        assertEquals("STREAM_UNSUPPORTED", r.getString("code"));
        assertEquals(0, streams.openCount());
    }

    @Test
    public void oneStreamPerConnectionAndAGlobalCap() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        assertTrue(call(c, "asr_stream_open").getBoolean("ok"));
        final JSONObject second = call(c, "asr_stream_open");
        assertEquals("STREAM_BUSY", second.getString("code"));
        for (int i = 1; i < BionicAsrStreams.MAX_STREAMS; i++) {
            assertTrue(call(new BionicAsrStreams.Client(), "asr_stream_open").getBoolean("ok"));
        }
        final JSONObject over = call(new BionicAsrStreams.Client(), "asr_stream_open");
        assertEquals("STREAM_BUSY", over.getString("code"));
    }

    @Test
    public void feedsAreBounded() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        call(c, "asr_stream_open", new JSONObject().put("sampleRate", 8000));
        final int perFeed = BionicAsrStreams.MAX_FEED_SECONDS * 8000;
        final JSONObject tooBig = call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", pcm(perFeed + 1)));
        assertEquals("FEED_TOO_LARGE", tooBig.getString("code"));
        final int feeds = BionicAsrStreams.MAX_STREAM_SECONDS / BionicAsrStreams.MAX_FEED_SECONDS;
        for (int i = 0; i < feeds; i++) {
            assertTrue(call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", pcm(perFeed))).getBoolean("ok"));
        }
        final JSONObject tooLong = call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", pcm(1)));
        assertEquals("STREAM_TOO_LONG", tooLong.getString("code"));
        final JSONObject ragged = call(c, "asr_stream_feed", new JSONObject().put("pcmBase64", "AAA="));
        assertFalse(ragged.getBoolean("ok"));
        final JSONObject badRate = call(new BionicAsrStreams.Client(), "asr_stream_open", new JSONObject().put("sampleRate", 4000));
        assertFalse(badRate.getBoolean("ok"));
    }

    @Test
    public void opsWithoutAStreamAreRejected() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        assertEquals("NO_STREAM", call(c, "asr_stream_partial").getString("code"));
        assertEquals("NO_STREAM", call(c, "asr_stream_finish").getString("code"));
        assertEquals("NO_STREAM", call(c, "asr_stream_feed").getString("code"));
        assertFalse(call(c, "asr_stream_close").getBoolean("closed"));
    }

    @Test
    public void cancelByIdSignalsTheStreamAndTheDecodeAnswersCancelled() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        final String id = call(c, "asr_stream_open").getString("streamId");
        assertTrue(new JSONObject(streams.cancel(id)).getBoolean("signalled"));
        assertEquals(1, fake.cancelled.size());
        assertFalse(new JSONObject(streams.cancel("unknown")).getBoolean("signalled"));
        fake.cancelNextDecode = true;
        assertEquals("CANCELLED", call(c, "asr_stream_partial").getString("code"));
        // The stream survives a cancelled decode.
        assertTrue(call(c, "asr_stream_partial").getBoolean("ok"));
    }

    @Test
    public void disconnectAndContextResetFreeStreams() throws Exception {
        final BionicAsrStreams.Client a = new BionicAsrStreams.Client();
        final BionicAsrStreams.Client b = new BionicAsrStreams.Client();
        final String idA = call(a, "asr_stream_open").getString("streamId");
        call(b, "asr_stream_open");
        streams.closeClient(a);
        assertEquals(1, streams.openCount());
        assertFalse(new JSONObject(streams.cancel(idA)).getBoolean("signalled"));
        streams.closeAll("test reset");
        assertEquals(0, streams.openCount());
        assertTrue(fake.open.isEmpty());
        assertEquals(2, fake.closed.size());
        assertEquals("NO_STREAM", call(b, "asr_stream_partial").getString("code"));
    }

    @Test
    public void nativeFaultClosesTheStreamAndPropagates() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        call(c, "asr_stream_open");
        fake.faultOnPartial = new RuntimeException("decoder fault");
        try {
            call(c, "asr_stream_partial");
            throw new AssertionError("expected the fault to propagate");
        } catch (RuntimeException expected) {
            assertEquals("decoder fault", expected.getMessage());
        }
        assertEquals(0, streams.openCount());
        assertEquals(null, c.session);
    }

    @Test
    public void rejectsNonFinitePcm() {
        final ByteBuffer bb = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        bb.putFloat(0.5f).putFloat(Float.NaN);
        try {
            BionicAsrStreams.decodePcm(Base64.getEncoder().encodeToString(bb.array()));
            throw new AssertionError("NaN must be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("non-finite"));
        }
        assertEquals(0, BionicAsrStreams.decodePcm("").length);
    }
}
