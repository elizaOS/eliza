package ai.eliza.voice;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.SpeechRecognizer;
import java.lang.reflect.Method;
import java.util.List;

/**
 * The real {@link OnDeviceRecognizer#available} against a scripted recognition service
 * (speech-pipeline/android-api): an error, a thrown create, a timeout or an interrupt is not "no
 * model", a "language not supported" error is, a late answer is kept, "no model" is asked again
 * after its window, a demote holds against a late answer, and the probe itself does nothing below
 * Android 13. Each case uses its own language, since the cache is per process.
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

        // "Language not supported" errors are a no-model answer: held for the absent window.
        for (int[] error : new int[][] {
                {SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, 0}, {SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, 1}}) {
            String language = error[1] == 0 ? "nl-NL" : "sv-SE";
            SpeechRecognizer.supportError = error[0];
            before = probes();
            check(!available(language), "a not-supported error reads false");
            advance(OnDeviceRecognizer.RETRY_AFTER_MILLIS);
            check(!available(language), "a not-supported error is held past the retry window");
            check(probes() == before + 1, "no probe within the absent window after a not-supported error");
            SpeechRecognizer.supportError = null;
            SpeechRecognizer.installed = List.of("en-US", language);
            advance(OnDeviceRecognizer.ABSENT_FOR_MILLIS - OnDeviceRecognizer.RETRY_AFTER_MILLIS);
            check(available(language), "after the absent window the next probe is believed");
        }
        SpeechRecognizer.installed = List.of("en-US", "de-DE", "it-IT", "es-US", "pt-BR");

        // (2) The service does not answer within 5 seconds; its late answer is kept.
        SpeechRecognizer.supportSilent = true;
        check(!available("es-US"), "a timeout reads false");
        SpeechRecognizer.supportSilent = false;
        before = probes();
        takePending().onSupportResult(new RecognitionSupport(List.of("es-US")));
        check(available("es-US"), "the late installed answer is kept");
        check(probes() == before, "no new probe after the late answer");

        // (2b) A late answer from an older probe does not overwrite a newer probe's answer.
        SpeechRecognizer.supportSilent = true;
        check(!available("ja-JP"), "probe 1 times out");
        RecognitionSupportCallback stale = takePending();
        SpeechRecognizer.supportSilent = false;
        SpeechRecognizer.installed = List.of("en-US", "ja-JP");
        advance(OnDeviceRecognizer.RETRY_AFTER_MILLIS);
        check(available("ja-JP"), "probe 2 answers installed");
        stale.onError(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED);
        stale.onSupportResult(new RecognitionSupport(List.of()));
        before = probes();
        check(available("ja-JP"), "a stale late no-model answer keeps the newer installed answer");
        check(probes() == before, "no new probe after the stale answer");
        SpeechRecognizer.installed = List.of("en-US", "de-DE", "it-IT", "es-US", "pt-BR");

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
        // The interrupted probe returns before the main thread reaches the service: stay silent
        // until the service holds its callback.
        RecognitionSupportCallback late = takePending();
        SpeechRecognizer.supportSilent = false;
        OnDeviceRecognizer.demote("pt-BR");
        late.onSupportResult(new RecognitionSupport(List.of("pt-BR")));
        before = probes();
        check(!available("pt-BR"), "a demote holds against a late answer");
        advance(1_000_000_000L);
        check(!available("pt-BR"), "a demote holds for the process");
        check(probes() == before, "a demoted language is not probed");

        // Below Android 13 the probe itself answers no model without touching the service.
        Method languageInstalled =
                OnDeviceRecognizer.class.getDeclaredMethod("languageInstalled", Context.class, String.class, long.class);
        languageInstalled.setAccessible(true);
        int sdk = Build.VERSION.SDK_INT;
        Build.VERSION.SDK_INT = 32;
        try {
            before = probes();
            Object below = languageInstalled.invoke(null, CONTEXT, "en-US", 0L);
            check("ABSENT".equals(String.valueOf(below)), "below Android 13 the probe answers no model");
            check(probes() == before, "below Android 13 the probe does not ask the service");
        } finally {
            Build.VERSION.SDK_INT = sdk;
        }

        System.out.println("PASS on-device recognizer probe wiring");
    }
}
