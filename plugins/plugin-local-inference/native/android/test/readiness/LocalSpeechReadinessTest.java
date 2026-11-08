package ai.eliza.voice;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;

/** Readiness by part over plain steps; no native library, bundle or device. */
public final class LocalSpeechReadinessTest {
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static LocalSpeechReadiness.Step step(List<String> ran, String name, boolean fails) {
        return () -> { ran.add(name); if (fails) throw new IOException(name + " failed"); };
    }
    public static void main(String[] args) {
        List<String> ran = new ArrayList<>();
        LocalSpeechReadiness absent = LocalSpeechReadiness.check(() -> false, step(ran, "install", false),
            step(ran, "voice", false), step(ran, "asr", false), () -> false);
        check(!absent.ready && !absent.playback && LocalSpeechReadiness.BUNDLE_ABSENT.equals(absent.reason), "missing bundle");
        check(ran.isEmpty(), "a missing bundle loads nothing");

        ran.clear();
        LocalSpeechReadiness noAsr = LocalSpeechReadiness.check(() -> true, step(ran, "install", false),
            step(ran, "voice", false), step(ran, "asr", true), () -> false);
        check(!noAsr.ready && noAsr.playback && LocalSpeechReadiness.ENGINE_LOAD_FAILED.equals(noAsr.reason), "speech output without recognition");
        check(ran.equals(List.of("install", "voice", "asr")), "every part checked in order");

        LocalSpeechReadiness noVoice = LocalSpeechReadiness.check(() -> true, () -> {},
            () -> { throw new UnsatisfiedLinkError("libvoice"); }, () -> {}, () -> false);
        check(!noVoice.ready && !noVoice.playback && LocalSpeechReadiness.ENGINE_LOAD_FAILED.equals(noVoice.reason), "native load failure");

        LocalSpeechReadiness storage = LocalSpeechReadiness.check(() -> true,
            () -> { throw new IOException("No space left on device"); }, () -> {}, () -> {}, () -> false);
        check(!storage.ready && !storage.playback && LocalSpeechReadiness.STORAGE.equals(storage.reason), "install failure");

        LocalSpeechReadiness ready = LocalSpeechReadiness.check(() -> true, () -> {}, () -> {}, () -> {}, () -> false);
        check(ready.ready && ready.playback && ready.reason == null, "both parts load");

        boolean[] cancelled = {false};
        try {
            LocalSpeechReadiness.check(() -> true, () -> {}, () -> { cancelled[0] = true; throw new IOException("fenced"); },
                () -> {}, () -> cancelled[0]);
            throw new AssertionError("a cancelled check answered");
        } catch (CancellationException expected) {}
        System.out.println("PASS local speech readiness by part");
    }
}
