package ai.eliza.voice;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;
public final class StreamContract {
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
            check(VoiceNative.created == created);
            session.synthesize("hello", 1);
            session.transcribe(new float[]{0.1f});
            check(VoiceNative.created == created + 1);
            check(VoiceNative.ttsContext == VoiceNative.asrContext);
            check(session.embed("hello", 1)[0] == VoiceNative.ttsContext);
            InferenceSession.TextStream text = session.openTextStream("hello", 8);
            check(text.next().equals("step"));
            int closedStreams = VoiceNative.textClosed;
            session.trimMemory();
            check(VoiceNative.destroyed == destroyed + 1 && VoiceNative.textClosed == closedStreams + 1);
            try { text.next(); throw new AssertionError(); } catch (IllegalStateException expected) {}
            session.synthesize("reload", 1);
            check(VoiceNative.created == created + 2);
            try { session.synthesizeStream("reentry", 1, (pcm, done) -> { session.close(); return true; }); throw new AssertionError(); } catch (IllegalStateException expected) {}
            check(VoiceNative.destroyed == destroyed + 1);
            session.synthesize("still usable", 1);
            session.close(); session.close();
            check(VoiceNative.destroyed == destroyed + 2);
            try { session.synthesize("closed", 1); throw new AssertionError(); } catch (IllegalStateException expected) {}
        } finally { session.close(); model.delete(); lexicon.delete(); asrDir.delete(); root.delete(); }
        System.out.println("Paradee stream and shared inference lifecycle contracts passed");
    }
}
