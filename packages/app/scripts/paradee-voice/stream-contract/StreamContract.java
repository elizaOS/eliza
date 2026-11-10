package ai.eliza.voice;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
public final class StreamContract {
    /** VAD under the same owner: own context and lock, unfenced by cancel, kept by trim, retired by close. */
    static void vadContract(File root, File model, File lexicon) throws Exception {
        InferenceSession session = new InferenceSession(root, model, lexicon, null);
        int created = VoiceNative.created, destroyed = VoiceNative.destroyed;
        check(session.vadSupported() && VoiceNative.created == created);
        InferenceSession.Vad vad = session.openVad();
        check(VoiceNative.created == created + 1 && VoiceNative.vadContext != 0);
        long vadContext = VoiceNative.vadContext;
        float[] two = new float[1024]; two[0] = 0.25f; two[512] = 0.75f;
        float[] probabilities = vad.process(two);
        check(probabilities.length == 2 && probabilities[0] == 0.25f && probabilities[1] == 0.75f);
        try { vad.process(new float[100]); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
        vad.reset();
        // Output cancellation and a speech stream holding the session lock never block or fence input.
        session.cancel();
        check(vad.process(new float[512]).length == 1);
        CountDownLatch streaming = new CountDownLatch(1), finish = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread speech = new Thread(() -> { try { session.synthesizeStream("hold", 1, (pcm, complete) -> { streaming.countDown(); await(finish); return true; }); } catch (Throwable error) { failure.set(error); } });
        speech.start(); await(streaming);
        InferenceSession.Vad second = session.openVad();
        check(second.process(new float[512]).length == 1);
        second.close(); second.close();
        finish.countDown(); join(speech);
        check(failure.get() == null);
        // The speech context and the VAD context are distinct native contexts.
        check(VoiceNative.ttsContext != vadContext);
        // Trim releases speech models but keeps an open detector usable.
        int beforeTrim = VoiceNative.destroyed;
        session.trimMemory();
        check(VoiceNative.destroyed == beforeTrim + 1 && vad.process(new float[512]).length == 1);
        // Close waits for a window in progress, retires every detector, then frees the VAD context.
        VoiceNative.vadEntered = new CountDownLatch(1); VoiceNative.vadRelease = new CountDownLatch(1);
        Thread window = new Thread(() -> { try { vad.process(new float[512]); } catch (Throwable error) { failure.set(error); } });
        window.start(); await(VoiceNative.vadEntered);
        int closedBefore = VoiceNative.vadClosed;
        Thread closer = new Thread(session::close); closer.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (closer.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
        check(closer.getState() == Thread.State.BLOCKED && VoiceNative.vadClosed == closedBefore);
        VoiceNative.vadRelease.countDown(); join(window); join(closer);
        VoiceNative.vadEntered = null; VoiceNative.vadRelease = null;
        check(failure.get() == null && VoiceNative.vadClosed == closedBefore + 1);
        try { vad.process(new float[512]); throw new AssertionError(); } catch (IllegalStateException expected) {}
        try { session.openVad(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        check(session.isClosed());
        // An idle VAD context is freed by trim; an unsupported engine opens nothing.
        InferenceSession idle = new InferenceSession(root, model, lexicon, null);
        idle.openVad().close();
        int beforeIdleTrim = VoiceNative.destroyed;
        idle.trimMemory();
        check(VoiceNative.destroyed == beforeIdleTrim + 1);
        VoiceNative.vadSupported = 0;
        int opened = VoiceNative.vadOpened;
        try { idle.openVad(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        check(!idle.vadSupported() && VoiceNative.vadOpened == opened);
        VoiceNative.vadSupported = 1;
        idle.close();
        check(VoiceNative.destroyed >= destroyed + 3);
    }
    /**
     * Independent consumers of one session: a client's cancel fences only its own calls and
     * interrupts the native call only while it is its own; a client's release drops only its
     * hold, and the models are freed when no client holds them. The session's cancel and close
     * still act on every client.
     */
    static void clientContract(File root, File model, File lexicon) throws Exception {
        InferenceSession session = new InferenceSession(root, model, lexicon, null);
        InferenceSession.Client first = session.client(), second = session.client();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        try {
            check(first.session() == session && second.session() == session);
            first.synthesize("first", 1);
            second.transcribe(new float[]{0.1f});
            int destroyed = VoiceNative.destroyed;
            first.release();
            check(session.isSpeechLoaded() && VoiceNative.destroyed == destroyed);
            first.synthesize("held again", 1);
            second.release();
            check(session.isSpeechLoaded() && VoiceNative.destroyed == destroyed);
            first.release();
            check(!session.isSpeechLoaded() && VoiceNative.destroyed == destroyed + 1);
            // While one client's stream holds the session, another client's cancel and release
            // neither interrupt it natively nor unload it, and fence only that client's queued call.
            CountDownLatch entered = new CountDownLatch(1), finish = new CountDownLatch(1);
            int[] chunks = {0};
            Thread speaking = new Thread(() -> { try { second.synthesizeStream("second", 1, (pcm, complete) -> { chunks[0]++; entered.countDown(); await(finish); return true; }); } catch (Throwable error) { failure.set(error); } });
            speaking.start(); await(entered);
            int calls = VoiceNative.calls, ttsCancels = VoiceNative.ttsCancels, asrCancels = VoiceNative.asrCancels;
            destroyed = VoiceNative.destroyed;
            Thread queued = new Thread(() -> { try { first.synthesizeStream("queued", 1, (pcm, complete) -> true); failure.set(new AssertionError("queued call ran")); } catch (CancellationException expected) {} catch (Throwable error) { failure.set(error); } });
            queued.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (queued.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
            check(queued.getState() == Thread.State.BLOCKED);
            first.cancel();
            first.release();
            check(VoiceNative.ttsCancels == ttsCancels && VoiceNative.asrCancels == asrCancels);
            finish.countDown(); join(speaking); join(queued);
            check(failure.get() == null && chunks[0] == 2 && VoiceNative.calls == calls);
            check(session.isSpeechLoaded() && VoiceNative.destroyed == destroyed);
            // A client's own cancel interrupts its running call natively, also from its PCM callback.
            ttsCancels = VoiceNative.ttsCancels;
            cancelled(() -> { try { second.synthesizeStream("own", 1, (pcm, complete) -> { second.cancel(); return true; }); } catch (java.io.IOException error) { throw new IllegalStateException(error); } });
            check(VoiceNative.ttsCancels == ttsCancels + 1);
            second.synthesize("after own cancel", 1);
            // Release is refused from the PCM callback, like trim and close.
            try { second.synthesizeStream("reentry", 1, (pcm, complete) -> { second.release(); return true; }); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(session.isSpeechLoaded());
            // The session's own cancel still fences a client's call.
            second.release();
            VoiceNative.afterTtsLoad = session::cancel;
            try { first.prepareSpeech(); throw new AssertionError(); } catch (CancellationException expected) {}
            first.prepareSpeech();
            // Close is terminal for every client and refuses new ones.
            session.close();
            try { first.synthesize("closed", 1); throw new AssertionError(); } catch (IllegalStateException expected) {}
            try { session.client(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        } finally { VoiceNative.afterTtsLoad = null; session.close(); }
    }
    /** A bundle's second speech language loads into its own voice slot of the shared context. */
    static void languageContract(File root, File model, File lexicon) throws Exception {
        File spanish = File.createTempFile("delibes", ".gguf");
        InferenceSession session = new InferenceSession(root, model, lexicon, null,
                java.util.Collections.singletonMap("es", spanish));
        try {
            check(session.speechLanguages().equals(java.util.Arrays.asList("en", "es")));
            check(session.synthesize("hola", 1, "es").samples.length > 0);
            check("es".equals(VoiceNative.loadedVoice));
            check(session.synthesize("hello", 1, "en").samples.length > 0);
            try { session.synthesize("bonjour", 1, "fr"); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
            int[] seen = {0};
            session.client().synthesizeStream("hola", 1, "es", (pcm, done) -> { seen[0]++; return true; });
            check(seen[0] > 0);
            session.trimMemory();
            check(VoiceNative.loadedVoice == null);
            // A host's speed range for one language is kept by the session: the slot takes it
            // when it loads, again after a trim, and at once when it is already loaded.
            VoiceNative.rangedVoice = null;
            session.speedRange("es", 0.5f, 1.5f);
            check(VoiceNative.rangedVoice == null);
            session.client().prepareVoice("es");
            check("es".equals(VoiceNative.loadedVoice) && "es".equals(VoiceNative.rangedVoice) && VoiceNative.rangeMin == 0.5f && VoiceNative.rangeMax == 1.5f);
            session.trimMemory();
            VoiceNative.rangedVoice = null;
            session.synthesize("hola", 1, "es");
            check("es".equals(VoiceNative.rangedVoice) && VoiceNative.rangeMin == 0.5f);
            session.speedRange("es", 0.75f, 1.25f);
            check(VoiceNative.rangeMin == 0.75f && VoiceNative.rangeMax == 1.25f);
            try { session.speedRange("fr", 0.5f, 1.5f); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
            try { session.speedRange("es", 1.1f, 1.5f); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
            check(VoiceNative.rangeMin == 0.75f);
            // The English voice alone, or recognition alone, loads for a readiness check.
            session.trimMemory();
            session.client().prepareRecognition();
            check(!session.isSpeechLoaded() && VoiceNative.loadedVoice == null);
            session.client().prepareVoice("en");
            check(session.isSpeechLoaded() && VoiceNative.loadedVoice == null);
        } finally { session.close(); spanish.delete(); }
        File other = File.createTempFile("delibes", ".gguf");
        try (ParadeeVoice voice = ParadeeVoice.slot(other, null, null, "es")) {
            check("es".equals(voice.language()) && "es".equals(voice.voiceId()) && voice.sampleRate() == 24000);
            check(voice.synthesize("hola", 1).samples.length > 0);
            try { voice.synthesizePhonemes("x", 1); throw new AssertionError(); } catch (IllegalStateException expected) {}
            // ABI v21: the caller's speed range reaches the voice's own slot; out-of-range values never reach native.
            voice.speedRange(0.5f, 1.5f);
            check("es".equals(VoiceNative.rangedVoice) && VoiceNative.rangeMin == 0.5f && VoiceNative.rangeMax == 1.5f);
            for (float[] bad : new float[][] {{0.2f, 1.5f}, {0.5f, 4.5f}, {1.1f, 1.5f}, {0.5f, 0.9f}, {Float.NaN, 1.5f}, {0.5f, Float.POSITIVE_INFINITY}}) {
                VoiceNative.rangedVoice = null;
                try { voice.speedRange(bad[0], bad[1]); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
                check(VoiceNative.rangedVoice == null);
            }
            voice.validatedSpeedRange();
            check("es".equals(VoiceNative.rangedVoice) && VoiceNative.rangeMin == 0f && VoiceNative.rangeMax == 0f);
        } finally { other.delete(); }
        check(ParadeeVoice.infoField("{\"a\":\"x\",\"sample_rate\":24000}", "sample_rate").equals("24000"));
    }
    /**
     * Batch calls: a cancel that lands after a call began, before the library cleared its cancel
     * flag, still ends that call cancelled, as does a cancel while it waits for the lock. The
     * next call is not hit.
     */
    static void batchCancelContract(File root, File model, File lexicon) throws Exception {
        try (ParadeeVoice voice = new ParadeeVoice(model, lexicon, null); NativeAsr asr = new NativeAsr(root)) {
            try {
                VoiceNative.entering = voice::cancel;
                cancelled(() -> voice.synthesize("lost", 1));
                cancelled(() -> voice.synthesizePhonemes("lost", 1));
                VoiceNative.entering = asr::cancel;
                cancelled(() -> asr.transcribe(new float[]{0.1f}));
            } finally { VoiceNative.entering = null; }
            check(voice.synthesize("next", 1).samples.length == 1);
            check(voice.synthesizePhonemes("next", 1).samples.length == 1);
            check(asr.transcribe(new float[]{0.1f}).equals(VoiceNative.heard));
            queuedCancelled(voice::cancel, () -> voice.synthesize("call", 1));
            queuedCancelled(voice::cancel, () -> voice.synthesizePhonemes("call", 1));
            queuedCancelled(asr::cancel, () -> asr.transcribe(new float[]{0.1f}));
        }
        // A loaded voice slot (nativeParadeeSynthesizeVoice) is fenced the same way.
        File other = File.createTempFile("delibes", ".gguf");
        try (ParadeeVoice voice = ParadeeVoice.slot(other, null, null, "es")) {
            try {
                VoiceNative.entering = voice::cancel;
                cancelled(() -> voice.synthesize("lost", 1));
            } finally { VoiceNative.entering = null; }
            check(voice.synthesize("next", 1).samples.length > 0);
            queuedCancelled(voice::cancel, () -> voice.synthesize("call", 1));
        } finally { other.delete(); }
    }
    /**
     * Per-request cancellation on one voice: cancelling a waiting request never runs it and never
     * interrupts the running one; cancelling the running request interrupts only it, and the
     * request waiting behind it still speaks. A cancel at native entry still ends that call
     * cancelled; a cancelled request stays cancelled; the voice's own cancel still fences a request.
     */
    static void requestCancelContract(File model, File lexicon) throws Exception {
        try (ParadeeVoice voice = new ParadeeVoice(model, lexicon, null)) {
            requestPair(voice, false, (text, request) -> voice.synthesize(text, 1, request));
            requestPair(voice, true, (text, request) -> voice.synthesize(text, 1, request));
            requestPair(voice, false, (text, request) -> voice.synthesizePhonemes(text, 1, request));
            requestPair(voice, true, (text, request) -> voice.synthesizePhonemes(text, 1, request));
            ParadeeVoice.Request entering = new ParadeeVoice.Request();
            try {
                VoiceNative.entering = entering::cancel;
                cancelled(() -> voice.synthesize("lost", 1, entering));
            } finally { VoiceNative.entering = null; }
            check(entering.isCancelled());
            int cancels = VoiceNative.ttsCancels, calls = nativeCalls(voice, entering);
            check(calls == 0 && VoiceNative.ttsCancels == cancels);
            check(voice.synthesize("next", 1, new ParadeeVoice.Request()).samples.length == 1);
            check(voice.synthesize("plain", 1, null).samples.length == 1);
            ParadeeVoice.Request fenced = new ParadeeVoice.Request();
            queuedCancelled(voice::cancel, () -> voice.synthesize("call", 1, fenced));
            check(!fenced.isCancelled());
        }
        File other = File.createTempFile("delibes", ".gguf");
        try (ParadeeVoice voice = ParadeeVoice.slot(other, null, null, "es")) {
            requestPair(voice, false, (text, request) -> voice.synthesize(text, 1, request));
            requestPair(voice, true, (text, request) -> voice.synthesize(text, 1, request));
        } finally { other.delete(); }
    }
    interface RequestCall { ParadeeVoice.Audio run(String text, ParadeeVoice.Request request); }
    /** Native calls a cancelled request reaches: none. */
    static int nativeCalls(ParadeeVoice voice, ParadeeVoice.Request request) {
        AtomicInteger calls = new AtomicInteger();
        VoiceNative.entering = calls::incrementAndGet;
        try { cancelled(() -> voice.synthesize("again", 1, request)); } finally { VoiceNative.entering = null; }
        return calls.get();
    }
    /**
     * Request one runs in native code and request two waits for the voice. Cancels one of them and
     * checks that only that one ends cancelled, and that only a running request is interrupted.
     */
    static void requestPair(ParadeeVoice voice, boolean cancelRunning, RequestCall call) throws Exception {
        ParadeeVoice.Request running = new ParadeeVoice.Request(), waiting = new ParadeeVoice.Request();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger nativeCalls = new AtomicInteger();
        VoiceNative.entering = () -> { if (nativeCalls.incrementAndGet() == 1) { entered.countDown(); await(release); } };
        AtomicReference<Object> first = new AtomicReference<>(), second = new AtomicReference<>();
        try {
            Thread active = new Thread(() -> { try { first.set(call.run("first", running)); } catch (Throwable error) { first.set(error); } });
            active.start(); await(entered);
            Thread queued = new Thread(() -> { try { second.set(call.run("second", waiting)); } catch (Throwable error) { second.set(error); } });
            queued.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (queued.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
            check(queued.getState() == Thread.State.BLOCKED);
            int cancels = VoiceNative.ttsCancels;
            (cancelRunning ? running : waiting).cancel();
            check(VoiceNative.ttsCancels == cancels + (cancelRunning ? 1 : 0));
            release.countDown(); join(active); join(queued);
        } finally { VoiceNative.entering = null; }
        Object cancelledResult = cancelRunning ? first.get() : second.get();
        Object spoken = cancelRunning ? second.get() : first.get();
        check(cancelledResult instanceof CancellationException);
        check(spoken instanceof ParadeeVoice.Audio && ((ParadeeVoice.Audio) spoken).samples.length > 0);
        check(nativeCalls.get() == (cancelRunning ? 2 : 1));
    }
    /**
     * One call runs in native code and a second waits for the lock; a cancel then ends both
     * cancelled, and the waiting call never reaches native code.
     */
    static void queuedCancelled(Runnable cancel, Runnable call) throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger nativeCalls = new AtomicInteger();
        VoiceNative.entering = () -> { nativeCalls.incrementAndGet(); entered.countDown(); await(release); };
        AtomicReference<Throwable> failure = new AtomicReference<>();
        try {
            Thread active = new Thread(() -> { try { cancelled(call); } catch (Throwable error) { failure.set(error); } });
            active.start(); await(entered);
            Thread queued = new Thread(() -> { try { cancelled(call); } catch (Throwable error) { failure.set(error); } });
            queued.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (queued.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
            check(queued.getState() == Thread.State.BLOCKED);
            cancel.run(); release.countDown(); join(active); join(queued);
        } finally { VoiceNative.entering = null; }
        check(failure.get() == null && nativeCalls.get() == 1);
    }
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void await(CountDownLatch latch) { try { check(latch.await(5, TimeUnit.SECONDS)); } catch (InterruptedException error) { throw new AssertionError(error); } }
    static void join(Thread thread) throws Exception { thread.join(5000); check(!thread.isAlive()); }
    static void cancelled(Runnable task) { try { task.run(); throw new AssertionError("Expected cancellation"); } catch (CancellationException expected) {} }
    public static void main(String[] args) throws Exception {
        // The speech thread count is set before the first voice loads, and is fixed after it.
        try { ParadeeVoice.setThreadCount(0); throw new AssertionError(); } catch (IllegalArgumentException expected) {}
        ParadeeVoice.setThreadCount(3);
        ParadeeVoice.setThreadCount(2);
        check(VoiceNative.speechThreads == 2);
        File model = File.createTempFile("paradee", ".gguf"), lexicon = File.createTempFile("paradee", ".lex");
        try (ParadeeVoice voice = new ParadeeVoice(model, lexicon, null)) {
            try { ParadeeVoice.setThreadCount(4); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(VoiceNative.speechThreads == 2);
            int[] seen = {0};
            voice.synthesizeStream("hello", 1, (pcm, complete) -> { check(complete ? pcm.length == 0 : pcm.length == 2); seen[0]++; return true; });
            check(seen[0] == 2);
            cancelled(() -> voice.synthesizeStream("hello", 1, (pcm, complete) -> false));
            cancelled(() -> voice.synthesizeStream("hello", 1, (pcm, complete) -> { voice.cancel(); return true; }));
            RuntimeException exact = new RuntimeException("sink");
            try { voice.synthesizeStream("hello", 1, (pcm, complete) -> { throw exact; }); throw new AssertionError(); } catch (RuntimeException error) { check(error == exact); }
            try { voice.synthesizeStream("hello", 1, (pcm, complete) -> { voice.trimMemory(); return true; }); throw new AssertionError(); } catch (IllegalStateException expected) {}
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            Thread active = new Thread(() -> { try { cancelled(() -> voice.synthesizeStream("active", 1, (pcm, complete) -> { entered.countDown(); await(release); return true; })); } catch (Throwable error) { failure.set(error); } });
            active.start(); await(entered);
            int before = VoiceNative.calls;
            Thread queued = new Thread(() -> { try { cancelled(() -> voice.synthesizeStream("queued", 1, (pcm, complete) -> true)); } catch (Throwable error) { failure.set(error); } });
            queued.start();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (queued.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
            check(queued.getState() == Thread.State.BLOCKED);
            voice.cancel(); release.countDown(); join(active); join(queued);
            check(failure.get() == null && VoiceNative.calls == before);
            voice.synthesizeStream("fresh", 1, (pcm, complete) -> true);
            int destroyed = VoiceNative.destroyed;
            try { voice.synthesizeStream("reentrant", 1, (pcm, complete) -> { voice.close(); return true; }); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(VoiceNative.destroyed == destroyed);
            CountDownLatch closingEntered = new CountDownLatch(1), closingRelease = new CountDownLatch(1);
            Thread streaming = new Thread(() -> { try { cancelled(() -> voice.synthesizeStream("close", 1, (pcm, complete) -> { closingEntered.countDown(); await(closingRelease); return true; })); } catch (Throwable error) { failure.set(error); } });
            streaming.start(); await(closingEntered);
            Thread closer = new Thread(voice::close); closer.start();
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (closer.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield();
            check(closer.getState() == Thread.State.BLOCKED && VoiceNative.destroyed == destroyed);
            int admittedBeforeClose = VoiceNative.calls;
            try { voice.synthesizeStream("late", 1, (pcm, complete) -> true); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(VoiceNative.calls == admittedBeforeClose);
            closingRelease.countDown(); join(streaming); join(closer);
            check(failure.get() == null && VoiceNative.destroyed == destroyed + 1);
        } finally { model.delete(); lexicon.delete(); }
        File root = java.nio.file.Files.createTempDirectory("inference-session-").toFile();
        File asrDir = new File(root, "asr"); check(asrDir.mkdir());
        model = new File(root, "model.gguf"); lexicon = new File(root, "lexicon.lex");
        check(model.createNewFile() && lexicon.createNewFile());
        int created = VoiceNative.created, destroyed = VoiceNative.destroyed;
        InferenceSession session = new InferenceSession(root, model, lexicon, null);
        try {
            check(!session.isSpeechLoaded());
            check(session.supportsStreaming());
            check(VoiceNative.created == created);
            check(!session.isSpeechLoaded());
            session.prepareSpeech();
            check(session.isSpeechLoaded());
            check(VoiceNative.created == created + 1);
            check(VoiceNative.ttsContext == VoiceNative.asrContext);
            check(session.speechSampleRate() == 24000);
            session.synthesize("hello", 1);
            session.transcribe(new float[]{0.1f});
            check(VoiceNative.created == created + 1);
            check(VoiceNative.ttsContext == VoiceNative.asrContext);
            check(session.embed("hello", 1)[0] == VoiceNative.ttsContext);
            InferenceSession.TextStream text = session.openTextStream("hello", 8);
            check(text.next().equals("step"));
            int closedStreams = VoiceNative.textClosed;
            session.trimMemory();
            check(!session.isSpeechLoaded());
            check(VoiceNative.destroyed == destroyed + 1 && VoiceNative.textClosed == closedStreams + 1);
            try { text.next(); throw new AssertionError(); } catch (IllegalStateException expected) {}
            session.synthesize("reload", 1);
            check(VoiceNative.created == created + 2);
            try { session.synthesizeStream("reentry", 1, (pcm, done) -> { session.close(); return true; }); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(VoiceNative.destroyed == destroyed + 1);
            session.synthesize("still usable", 1);
            session.close(); session.close();
            check(!session.isSpeechLoaded());
            check(VoiceNative.destroyed == destroyed + 2);
            try { session.synthesize("closed", 1); throw new AssertionError(); } catch (IllegalStateException expected) {}
            try { session.prepareSpeech(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        } finally { session.close(); }
        InferenceSession cancelledLoad = new InferenceSession(root, model, lexicon, null);
        try {
            int beforeLoad = VoiceNative.created;
            VoiceNative.afterTtsLoad = cancelledLoad::cancel;
            try { cancelledLoad.prepareSpeech(); throw new AssertionError(); } catch (CancellationException expected) {}
            check(cancelledLoad.isSpeechLoaded());
            cancelledLoad.prepareSpeech();
            check(VoiceNative.created == beforeLoad + 1);
            check(VoiceNative.ttsContext == VoiceNative.asrContext);
        } finally { cancelledLoad.close(); }
        vadContract(root, model, lexicon);
        clientContract(root, model, lexicon);
        languageContract(root, model, lexicon);
        batchCancelContract(root, model, lexicon);
        requestCancelContract(model, lexicon);
        model.delete(); lexicon.delete(); asrDir.delete(); root.delete();
        System.out.println("Paradee stream and shared inference lifecycle contracts passed");
    }
}
