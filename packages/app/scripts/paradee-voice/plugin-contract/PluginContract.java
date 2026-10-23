package ai.eliza.voice;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;

/**
 * JVM contract for the plugin's Android-free rules. With "wer" it prints
 * {@link Wer#normalize} for each stdin line so the test can compare it with
 * wer.ts. With "route" it checks {@link TranscriptionRoute} and
 * {@link RequestCancels} and exits non-zero on the first failure.
 */
final class PluginContract {
    private PluginContract() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("wer")) {
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            for (String line; (line = in.readLine()) != null; ) System.out.println(String.join(" ", Wer.normalize(line)));
            return;
        }
        route();
        cancels();
    }

    private static void check(boolean condition, String rule) {
        if (!condition) throw new AssertionError(rule);
    }

    private static void route() {
        check(TranscriptionRoute.limitMillis(0) == 6_000, "an empty recording gets the floor");
        check(TranscriptionRoute.limitMillis(10 * 32_000) == 14_000, "ten seconds get 4 s over the audio");
        check(TranscriptionRoute.limitMillis(Integer.MAX_VALUE) == 64_000, "never past the ceiling");
        byte[] silence = new byte[32_000];
        byte[] speech = new byte[32_000];
        for (int i = 0; i < speech.length; i += 2) {
            short sample = (short) ((i / 2) % 40 < 20 ? 8000 : -8000);
            speech[i] = (byte) sample;
            speech[i + 1] = (byte) (sample >> 8);
        }
        check(!TranscriptionRoute.containsSpeech(silence) && TranscriptionRoute.containsSpeech(speech), "speech detection");
        List<String> log = new ArrayList<>();
        int[] demoted = {0};
        Runnable demote = () -> demoted[0]++;

        TranscriptionRoute.Heard timedOut = TranscriptionRoute.transcribe(silence, true,
                () -> { throw new RecognizerUnavailable(RecognizerUnavailable.TIMEOUT); }, () -> "pay the bill", demote, log::add);
        check(demoted[0] == 1 && timedOut.demoted && "asr".equals(timedOut.engine) && "pay the bill".equals(timedOut.text)
                && !timedOut.fellBack, "a timeout demotes and the native ASR hears");

        TranscriptionRoute.Heard failed = TranscriptionRoute.transcribe(silence, true,
                () -> { throw new RecognizerUnavailable("error 5"); }, () -> "yes", demote, log::add);
        check(demoted[0] == 1 && !failed.demoted && "asr".equals(failed.engine), "another failure does not demote");

        TranscriptionRoute.Heard quiet = TranscriptionRoute.transcribe(silence, true, () -> "", () -> "never", demote, log::add);
        check(demoted[0] == 1 && "android".equals(quiet.engine) && quiet.text.isEmpty(), "silence may come back empty");

        TranscriptionRoute.Heard empty = TranscriptionRoute.transcribe(speech, true, () -> "", () -> "hello", demote, log::add);
        check(demoted[0] == 2 && empty.demoted && empty.fellBack && "hello".equals(empty.text), "no words in speech demotes");

        TranscriptionRoute.Heard answered = TranscriptionRoute.transcribe(speech, true, () -> "hello", () -> "never", demote, log::add);
        check(demoted[0] == 2 && !answered.demoted && "android".equals(answered.engine), "a good answer stands");

        check(TranscriptionRoute.transcribe(speech, false, () -> "never", () -> null, demote, log::add) == null,
                "no recognizer and no ASR is null");
        check(!new RecognizerUnavailable("no pipe").timedOut, "only the limit is a timeout");
        for (String line : log) check(!line.contains("pay the bill") && !line.contains("hello"), "the log never holds words");
    }

    private static void cancels() {
        RequestCancels cancels = new RequestCancels();
        cancels.queue("a");
        check(cancels.cancel("a"), "a queued request can be cancelled");
        boolean stoppedBeforeStart = false;
        try {
            cancels.running("a", () -> {});
        } catch (CancellationException stopped) {
            stoppedBeforeStart = true;
        }
        check(stoppedBeforeStart, "cancel while queued stops the request when it starts");
        cancels.finish("a");
        check(cancels.pending() == 0 && cancels.marks() == 0, "a cancelled request leaves nothing behind");
        int[] stops = {0};
        cancels.queue("b");
        cancels.running("b", () -> stops[0]++);
        check(cancels.cancel("b") && stops[0] == 1, "cancel stops a running request");
        cancels.finish("b");
        check(!cancels.cancel("b") && cancels.marks() == 0, "a finished request cannot be cancelled");
        cancels.queue("c");
        cancels.running("c", () -> stops[0]++);
        cancels.cancelAll();
        check(stops[0] == 2, "cancelAll stops running requests");
    }
}
