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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
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
        /** When set, finish blocks until released or cancelled (the context-wide flag). */
        CountDownLatch finishEntered;
        CountDownLatch releaseFinish;
        volatile boolean contextCancelled;

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

        @Override public String finish(long stream) {
            if (releaseFinish != null) {
                contextCancelled = false; // the native decode clears the flag when it starts
                finishEntered.countDown();
                try {
                    while (!releaseFinish.await(5, TimeUnit.MILLISECONDS)) {
                        if (contextCancelled) throw new CancellationException("cancelled");
                    }
                } catch (InterruptedException e) {
                    throw new IllegalStateException(e);
                }
            }
            return "secret final " + fed;
        }

        @Override public void cancel(long stream) {
            cancelled.add(stream);
            contextCancelled = true; // like eliza_inference_asr_cancel(ctx)
        }

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

    /** Run finish for {@code client} on another thread; returns once it is decoding. */
    private Thread finishInBackground(BionicAsrStreams.Client client, AtomicReference<JSONObject> result)
            throws Exception {
        fake.finishEntered = new CountDownLatch(1);
        fake.releaseFinish = new CountDownLatch(1);
        final Thread t = new Thread(() -> {
            try {
                result.set(call(client, "asr_stream_finish"));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        t.start();
        assertTrue(fake.finishEntered.await(5, TimeUnit.SECONDS));
        return t;
    }

    @Test
    public void cancelByIdStopsThatStreamsDecode() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        final String id = call(c, "asr_stream_open").getString("streamId");
        final AtomicReference<JSONObject> result = new AtomicReference<>();
        final Thread t = finishInBackground(c, result);
        assertTrue(new JSONObject(streams.cancel(id)).getBoolean("signalled"));
        t.join(5000);
        assertEquals("CANCELLED", result.get().getString("code"));
        assertFalse(new JSONObject(streams.cancel("unknown")).getBoolean("signalled"));
        // The stream survives a cancelled decode.
        fake.releaseFinish = null;
        fake.cancelNextDecode = true;
        assertEquals("CANCELLED", call(c, "asr_stream_partial").getString("code"));
        assertTrue(call(c, "asr_stream_partial").getBoolean("ok"));
    }

    @Test
    public void cancellingAnotherStreamLeavesTheRunningFinishAlone() throws Exception {
        final BionicAsrStreams.Client a = new BionicAsrStreams.Client();
        final BionicAsrStreams.Client b = new BionicAsrStreams.Client();
        final String idA = call(a, "asr_stream_open").getString("streamId");
        call(b, "asr_stream_open");
        final AtomicReference<JSONObject> result = new AtomicReference<>();
        final Thread t = finishInBackground(b, result);
        assertFalse(new JSONObject(streams.cancel(idA)).getBoolean("signalled"));
        fake.releaseFinish.countDown();
        t.join(5000);
        assertTrue(result.get().toString(), result.get().getBoolean("ok"));
        assertTrue("no native cancel while B decodes", fake.cancelled.isEmpty());
    }

    @Test
    public void streamCancelDoesNotStopABatchTranscription() throws Exception {
        final BionicAsrStreams.Client a = new BionicAsrStreams.Client();
        final String idA = call(a, "asr_stream_open").getString("streamId");
        final List<String> batchSignals = new ArrayList<>();
        assertFalse("no batch running", streams.cancelBatch(() -> batchSignals.add("asr")));
        streams.beginBatch();
        try {
            assertFalse(new JSONObject(streams.cancel(idA)).getBoolean("signalled"));
            assertTrue(fake.cancelled.isEmpty());
            assertTrue(streams.cancelBatch(() -> batchSignals.add("asr")));
        } finally {
            streams.endBatch();
        }
        assertEquals(1, batchSignals.size());
    }

    @Test
    public void cancelCurrentStopsWhicheverDecodeRuns() throws Exception {
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        call(c, "asr_stream_open");
        final List<String> batchSignals = new ArrayList<>();
        streams.cancelCurrent(() -> batchSignals.add("asr"));
        assertTrue("nothing decoding, nothing signalled", fake.cancelled.isEmpty() && batchSignals.isEmpty());
        final AtomicReference<JSONObject> result = new AtomicReference<>();
        final Thread t = finishInBackground(c, result);
        streams.cancelCurrent(() -> batchSignals.add("asr"));
        t.join(5000);
        assertEquals("CANCELLED", result.get().getString("code"));
        streams.beginBatch();
        streams.cancelCurrent(() -> batchSignals.add("asr"));
        streams.endBatch();
        assertEquals(1, batchSignals.size());
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
        assertTrue("closing an idle stream must not cancel the shared context", fake.cancelled.isEmpty());
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

    @Test
    public void nonLoadingStatusProbeNeverRequestsContextOrAcquiresModel() throws Exception {
        final AtomicReference<Boolean> ctxRequested = new AtomicReference<>(false);
        final AtomicReference<String> probedBundle = new AtomicReference<>();
        final BionicAsrStreams.Native nonLoading = new BionicAsrStreams.Native() {
            @Override public int probeSupported(String bundleDir) {
                probedBundle.set(bundleDir);
                return bundleDir.isEmpty() ? 0 : 1;
            }
            @Override public int supported(long ctx) {
                throw new AssertionError("supported(ctx) must not run when probeSupported answers");
            }
            @Override public long open(long ctx, int sampleRate) { return 1L; }
            @Override public int feed(long stream, float[] pcm) { return pcm.length; }
            @Override public String partial(long stream) { return ""; }
            @Override public String finish(long stream) { return ""; }
            @Override public void cancel(long stream) {}
            @Override public void close(long stream) {}
        };
        final BionicAsrStreams probeStreams = new BionicAsrStreams(nonLoading, logs::add);
        final BionicAsrStreams.Client c = new BionicAsrStreams.Client();
        final JSONObject res = new JSONObject(probeStreams.handle(
            c,
            "asr_stream_supported",
            new JSONObject().put("op", "asr_stream_supported").put("bundleDir", "/tmp/voice-bundle"),
            () -> {
                ctxRequested.set(true);
                throw new AssertionError("asr_stream_supported must not create or reset residentCtx");
            }));
        assertTrue(res.getBoolean("ok"));
        assertTrue(res.getBoolean("supported"));
        assertFalse(ctxRequested.get());
        assertEquals("/tmp/voice-bundle", probedBundle.get());
    }

    private static byte[] syntheticGguf(String architecture) {
        final byte[] key = "general.architecture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        final byte[] val = architecture.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        final int size = 24 + 8 + key.length + 4 + 8 + val.length;
        final ByteBuffer bb = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);
        bb.put((byte) 'G').put((byte) 'G').put((byte) 'U').put((byte) 'F');
        bb.putInt(3); // GGUF v3
        bb.putLong(0L); // tensor_count
        bb.putLong(1L); // kv_count
        bb.putLong(key.length).put(key);
        bb.putInt(8); // GGUF_TYPE_STRING
        bb.putLong(val.length).put(val);
        return bb.array();
    }

    @Test
    public void probeAsrStreamSupportedChecksBundleWithoutLoadingModel() throws Exception {
        final java.io.File bundle = java.nio.file.Files.createTempDirectory("bionic-asr-probe-").toFile();
        final java.io.File asrDir = new java.io.File(bundle, "asr");
        final java.io.File model = new java.io.File(asrDir, "phonon-2-fv5.gguf");
        final java.io.File container = new java.io.File(bundle, "base.apk");
        try {
            // Missing asr/ directory -> unavailable.
            try {
                ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> null);
                throw new AssertionError("expected missing asr/ to throw");
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("no asr/ model"));
            }
            assertTrue(asrDir.mkdir());
            // Cold parakeet-tdt GGUF -> supported (1) without loading the model.
            java.nio.file.Files.write(model.toPath(), syntheticGguf("parakeet-tdt"));
            assertEquals(1, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> null));
            // Explicit ELIZA_ASR_BACKEND=qwen3 overrides to unsupported (0) when cold.
            assertEquals(0, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> "qwen3"));
            // Warm (asrStreamSupported == 1) -> supported (1).
            assertEquals(1, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 1, () -> null));
            // Cold qwen3 GGUF -> unsupported (0) so transcribeViaBionicHost takes batch op="asr".
            java.nio.file.Files.write(model.toPath(), syntheticGguf("qwen3"));
            assertEquals(0, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> null));
            // Non-GGUF file -> unsupported (0).
            java.nio.file.Files.write(model.toPath(), "not-a-gguf".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertEquals(0, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> null));
            // Cold parakeet-tdt via eliza-file-region v1 region file -> supported (1).
            final byte[] parakeetHeader = syntheticGguf("parakeet-tdt");
            final byte[] padded = new byte[32 + parakeetHeader.length];
            System.arraycopy(parakeetHeader, 0, padded, 32, parakeetHeader.length);
            java.nio.file.Files.write(container.toPath(), padded);
            final String region = "eliza-file-region v1\noffset=32\nlength=" + parakeetHeader.length
                + "\npath=" + container.getAbsolutePath() + "\n";
            java.nio.file.Files.write(model.toPath(), region.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertEquals(1, ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 1, () -> 0, () -> null));
            // Native ASR unsupported -> unavailable.
            try {
                ElizaBionicInferenceServer.probeAsrStreamSupported(bundle.getAbsolutePath(), () -> 0, () -> 0, () -> null);
                throw new AssertionError("expected native ASR unsupported to throw");
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("native ASR unsupported"));
            }
        } finally {
            model.delete();
            container.delete();
            asrDir.delete();
            bundle.delete();
        }
    }
}
