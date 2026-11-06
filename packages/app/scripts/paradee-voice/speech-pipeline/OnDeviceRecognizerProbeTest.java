package ai.eliza.voice;

import android.content.Context;
import android.os.SystemClock;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.SpeechRecognizer;
import java.util.List;

/**
 * The real {@link OnDeviceRecognizer#available} against a scripted recognition service
 * (speech-pipeline/android-api): an error, a thrown create, a timeout or an interrupt is not "no
 * model", a late answer is kept, "no model" is asked again after its window, and a demote holds
 * against a late answer. Each case uses its own language, since the cache is per process.
 */
public final class OnDeviceRecognizerProbeTest {
    static final Context CONTEXT = new Context();

    static void check(boolean value, String what) {
        if (!value) throw new AssertionError(what);
    }

    static boolean available(String language) {
        return OnDeviceRecognizer.available(CONTEXT, language);
    }

    static int probes() {
        return SpeechRecognizer.probes.get();
    }

    static void advance(long millis) {
        SystemClock.now += millis;
    }

    /** Waits for the scripted service to hold a probe's callback, then takes it. */
    static RecognitionSupportCallback takePending() throws InterruptedException {
        for (int wait = 0; wait < 500 && SpeechRecognizer.pending == null; wait++) Thread.sleep(10);
        RecognitionSupportCallback callback = SpeechRecognizer.pending;
        check(callback != null, "the probe reached the recognition service");
        SpeechRecognizer.pending = null;
        return callback;
    }

    public static void main(String[] args) throws Exception {
        SpeechRecognizer.installed = List.of("en-US", "de-DE", "it-IT", "es-US", "pt-BR");

        // (1) The service errors: false now, asked again after the retry window and believed.
        SpeechRecognizer.supportError = SpeechRecognizer.ERROR_SERVER_DISCONNECTED;
        int before = probes();
        check(!available("de-DE"), "an error reads false");
        SpeechRecognizer.supportError = null;
        advance(OnDeviceRecognizer.RETRY_AFTER_MILLIS - 1);
        check(!available("de-DE"), "an error reads false within the retry window");
        check(probes() == before + 1, "no probe within the retry window");
        advance(1);
        check(available("de-DE"), "after an error the next probe is believed");
        check(probes() == before + 2, "one new probe after the retry window");

        // The service is not bound yet (create throws): the same, not "no model".
        SpeechRecognizer.createThrows = true;
        check(!available("it-IT"), "a thrown create reads false");
        SpeechRecognizer.createThrows = false;
        advance(OnDeviceRecognizer.RETRY_AFTER_MILLIS);
        check(available("it-IT"), "after a thrown create the next probe is believed");

        // (2) The service does not answer within 5 seconds; its late answer is kept.
        SpeechRecognizer.supportSilent = true;
        check(!available("es-US"), "a timeout reads false");
        SpeechRecognizer.supportSilent = false;
        before = probes();
        takePending().onSupportResult(new RecognitionSupport(List.of("es-US")));
        check(available("es-US"), "the late installed answer is kept");
        check(probes() == before, "no new probe after the late answer");

        // (3) No model: held for its window, then a model installed later is seen.
        SpeechRecognizer.installed = List.of("en-US");
        check(!available("fr-FR"), "no model reads false");
        SpeechRecognizer.installed = List.of("en-US", "fr-FR");
        before = probes();
        advance(OnDeviceRecognizer.ABSENT_FOR_MILLIS - 1_000);
        check(!available("fr-FR"), "no model is held for 59 seconds");
        check(probes() == before, "no probe while no model is held");
        advance(1_000);
        check(available("fr-FR"), "a model installed later is seen at 60 seconds");

        // (4) An interrupted probe, then a demote: the late answer does not undo the demote.
        SpeechRecognizer.supportSilent = true;
        Thread.currentThread().interrupt();
        check(!available("pt-BR"), "an interrupted probe reads false");
        check(Thread.interrupted(), "the interrupt is kept for the caller");
        SpeechRecognizer.supportSilent = false;
        RecognitionSupportCallback late = takePending();
        OnDeviceRecognizer.demote("pt-BR");
        late.onSupportResult(new RecognitionSupport(List.of("pt-BR")));
        before = probes();
        check(!available("pt-BR"), "a demote holds against a late answer");
        advance(1_000_000_000L);
        check(!available("pt-BR"), "a demote holds for the process");
        check(probes() == before, "a demoted language is not probed");

        System.out.println("PASS on-device recognizer probe wiring");
    }
}
