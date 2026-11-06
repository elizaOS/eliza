package ai.eliza.voice;

import android.content.Context;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * The real {@link OnDeviceRecognizer} session against a scripted recognition service
 * (speech-pipeline/android-api): the service hears fed audio before {@link
 * OnDeviceRecognizer#finish}, finish ends the audio and returns the answer, an answer before finish
 * is kept, a timeout, a cancel and a service error keep their meaning, and every ended session
 * frees its recognizer and pipe. {@link OnDeviceRecognizer#transcribe} is the same session.
 */
public final class OnDeviceRecognizerSessionTest {
    static final Context CONTEXT = new Context();

    static void check(boolean value, String what) {
        if (!value) throw new AssertionError(what);
    }

    static void waitFor(BooleanSupplier condition, String what) throws InterruptedException {
        for (int wait = 0; wait < 500 && !condition.getAsBoolean(); wait++) Thread.sleep(10);
        check(condition.getAsBoolean(), what);
    }

    /** Waits for a new session to reach the service and returns its recognizer. */
    static SpeechRecognizer listening(SpeechRecognizer previous) throws InterruptedException {
        waitFor(() -> SpeechRecognizer.listening != null && SpeechRecognizer.listening != previous,
                "the session reached the recognition service");
        return SpeechRecognizer.listening;
    }

    static ParcelFileDescriptor source(SpeechRecognizer service) {
        return (ParcelFileDescriptor) service.intent.extra(RecognizerIntent.EXTRA_AUDIO_SOURCE);
    }

    static Bundle heard(String text) {
        Bundle results = new Bundle();
        results.results = new ArrayList<>(List.of(text));
        return results;
    }

    static byte[] pcm(int length, int seed) {
        byte[] bytes = new byte[length];
        for (int i = 0; i < length; i++) bytes[i] = (byte) (i * 31 + seed);
        return bytes;
    }

    static byte[] join(byte[] first, byte[] second) {
        byte[] both = Arrays.copyOf(first, first.length + second.length);
        System.arraycopy(second, 0, both, first.length, second.length);
        return both;
    }

    /** Runs {@code finish} on a worker, as a host does, and keeps its outcome. */
    static final class Finishing {
        final AtomicReference<Object> outcome = new AtomicReference<>();
        final Thread thread;

        Finishing(OnDeviceRecognizer recognizer, long limitMillis) {
            thread = new Thread(() -> {
                try {
                    outcome.set(recognizer.finish(limitMillis));
                } catch (Throwable error) {
                    outcome.set(error);
                }
            });
            thread.start();
        }

        Object await() throws InterruptedException {
            thread.join(5_000);
            check(!thread.isAlive(), "finish returned");
            return outcome.get();
        }
    }

    static void released(SpeechRecognizer service) throws InterruptedException {
        waitFor(() -> service.destroyed, "the recognizer is destroyed");
        waitFor(() -> source(service).isClosed(), "the read end of the pipe is closed");
    }

    public static void main(String[] args) throws Exception {
        // (1) Live: the service hears each part while she speaks, before finish; finish ends the
        // audio and returns the service's answer. A fed array the caller reuses is copied.
        OnDeviceRecognizer live = new OnDeviceRecognizer(CONTEXT);
        byte[] first = pcm(10_000, 1), reused = first.clone();
        live.feed(reused);
        Arrays.fill(reused, (byte) 0);
        SpeechRecognizer service = listening(null);
        ParcelFileDescriptor audio = source(service);
        waitFor(() -> Arrays.equals(audio.received(), first), "the service hears the first part before finish");
        check(!audio.ended(), "the audio stays open until finish");
        byte[] second = pcm(7_001, 2);
        live.feed(second);
        live.feed(new byte[0]);
        waitFor(() -> Arrays.equals(audio.received(), join(first, second)), "the service hears the second part");
        check(SpeechRecognizer.created.get() == 1, "one recognizer for the session");
        Finishing finishing = new Finishing(live, 5_000);
        waitFor(audio::ended, "finish ends the audio");
        service.listener.onResults(heard("good morning"));
        check("good morning".equals(finishing.await()), "finish returns the service's answer");
        released(service);
        check(!service.cancelled, "a finished session is not cancelled");
        expect(IllegalStateException.class, () -> live.feed(first), "feed after finish is refused");
        expect(IllegalStateException.class, () -> live.finish(1_000), "a second finish is refused");

        // (2) An answer before finish (the service heard the end of speech) is kept, and later
        // audio is accepted and not written.
        OnDeviceRecognizer early = new OnDeviceRecognizer(CONTEXT);
        early.feed(pcm(3_200, 3));
        service = listening(service);
        ParcelFileDescriptor earlyAudio = source(service);
        waitFor(() -> earlyAudio.received().length == 3_200, "the service hears the audio");
        service.listener.onError(SpeechRecognizer.ERROR_NO_MATCH);
        Thread.sleep(50);
        early.feed(pcm(3_200, 4));
        check("".equals(early.finish(5_000)), "no speech heard before finish is an empty transcript");
        check(earlyAudio.received().length == 3_200, "no audio is written after the answer");
        released(service);

        // (3) No answer within the limit after finish: TIMEOUT, and the session is freed.
        OnDeviceRecognizer slow = new OnDeviceRecognizer(CONTEXT);
        slow.feed(pcm(1_000, 5));
        service = listening(service);
        long started = System.nanoTime();
        try {
            slow.finish(100);
            throw new AssertionError("a silent service times out");
        } catch (RecognizerUnavailable expected) {
            check(expected.timedOut, "the timeout keeps RecognizerUnavailable.TIMEOUT");
        }
        check(System.nanoTime() - started < 2_000_000_000L, "the limit holds");
        released(service);

        // (4) Cancel while finish waits: CancellationException, and the recognizer is cancelled.
        OnDeviceRecognizer stopped = new OnDeviceRecognizer(CONTEXT);
        stopped.feed(pcm(1_000, 6));
        service = listening(service);
        finishing = new Finishing(stopped, 5_000);
        waitFor(source(service)::ended, "finish ends the audio");
        stopped.cancel();
        check(finishing.await() instanceof CancellationException, "cancel ends finish with CancellationException");
        check(service.cancelled, "cancel cancels the recognizer");
        released(service);

        // (5) Cancel during speech, with no finish: the session is freed; later audio is dropped.
        OnDeviceRecognizer abandoned = new OnDeviceRecognizer(CONTEXT);
        abandoned.feed(pcm(1_000, 7));
        service = listening(service);
        abandoned.cancel();
        released(service);
        abandoned.feed(pcm(1_000, 8));
        expect(CancellationException.class, () -> abandoned.finish(1_000), "finish after cancel");

        // (6) Cancel before any audio: no recognizer starts.
        int before = SpeechRecognizer.created.get();
        OnDeviceRecognizer never = new OnDeviceRecognizer(CONTEXT);
        never.cancel();
        never.feed(pcm(1_000, 9));
        expect(CancellationException.class, () -> never.finish(1_000), "finish after an early cancel");
        Thread.sleep(50);
        check(SpeechRecognizer.created.get() == before, "a cancelled session starts no recognizer");

        // (7) A service error other than no speech is RecognizerUnavailable; a missing model demotes.
        OnDeviceRecognizer missing = new OnDeviceRecognizer(CONTEXT, "nb-NO");
        missing.feed(pcm(1_000, 10));
        service = listening(service);
        SpeechRecognizer failing = service;
        finishing = new Finishing(missing, 5_000);
        waitFor(source(failing)::ended, "finish ends the audio");
        failing.listener.onError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE);
        Object failure = finishing.await();
        check(failure instanceof RecognizerUnavailable && !((RecognizerUnavailable) failure).timedOut,
                "a service error is RecognizerUnavailable");
        before = SpeechRecognizer.probes.get();
        check(!OnDeviceRecognizer.available(CONTEXT, "nb-NO"), "a missing model demotes the language");
        check(SpeechRecognizer.probes.get() == before, "a demoted language is not probed");
        released(failing);

        // (8) transcribe is the same session over a finished recording.
        OnDeviceRecognizer recording = new OnDeviceRecognizer(CONTEXT);
        byte[] whole = pcm(20_000, 11);
        AtomicReference<Object> transcript = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                transcript.set(recording.transcribe(whole, 5_000));
            } catch (Throwable error) {
                transcript.set(error);
            }
        });
        worker.start();
        service = listening(service);
        ParcelFileDescriptor recorded = source(service);
        waitFor(recorded::ended, "transcribe writes the recording and ends it");
        check(Arrays.equals(recorded.received(), whole), "the service hears the whole recording");
        service.listener.onResults(heard("call my daughter"));
        worker.join(5_000);
        check("call my daughter".equals(transcript.get()), "transcribe returns the answer");
        released(service);

        System.out.println("PASS on-device recognizer session");
    }

    interface Call {
        void run() throws Exception;
    }

    static void expect(Class<? extends Throwable> type, Call call, String what) {
        try {
            call.run();
        } catch (Throwable error) {
            check(type.isInstance(error), what + ": " + error);
            return;
        }
        throw new AssertionError(what + ": no " + type.getSimpleName());
    }
}
