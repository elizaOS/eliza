package ai.eliza.voice;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CancellationException;
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
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void await(CountDownLatch latch) { try { check(latch.await(5, TimeUnit.SECONDS)); } catch (InterruptedException error) { throw new AssertionError(error); } }
    static void join(Thread thread) throws Exception { thread.join(5000); check(!thread.isAlive()); }
    static void cancelled(Runnable task) { try { task.run(); throw new AssertionError("Expected cancellation"); } catch (CancellationException expected) {} }
    public static void main(String[] args) throws Exception {
        File model = File.createTempFile("paradee", ".gguf"), lexicon = File.createTempFile("paradee", ".lex");
        try (ParadeeVoice voice = new ParadeeVoice(model, lexicon, null)) {
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
        model.delete(); lexicon.delete(); asrDir.delete(); root.delete();
        System.out.println("Paradee stream and shared inference lifecycle contracts passed");
    }
}
