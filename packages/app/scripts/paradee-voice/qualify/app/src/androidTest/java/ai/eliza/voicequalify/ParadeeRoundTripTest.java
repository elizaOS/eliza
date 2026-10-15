package ai.eliza.voicequalify;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Speaks each sentence with Paradee-8M on the device, hears it again with the
 * native Phonon-2 ASR of the same :paradee-voice bundle, and reports corpus WER
 * and RTF (synthesis time / audio time). Pass: WER <= 0.08, as on the host.
 *
 * Sentences: assets/sentences.txt (the 25 qualify sentences), plus
 * tts-sentences.txt (Paradee card samples + 200 held-out WikiText sentences)
 * when `host-wer-gate.ts --export-device-fixtures` was passed as
 * -PasrFixturesDir. Instrumentation arguments: maxWer, limit.
 * Report: Android/data/ai.eliza.voicequalify/files/paradee-roundtrip.json.
 */
@RunWith(AndroidJUnit4.class)
public class ParadeeRoundTripTest {
    private static final String TAG = "ParadeeRoundTrip";

    @Test
    public void paradeeSpeechIsHeardByNativeAsr() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bundle args = InstrumentationRegistry.getArguments();
        double maxWer = Double.parseDouble(args.getString("maxWer", String.valueOf(Wer.TTS_ROUND_TRIP_MAX_WER)));
        List<String[]> items = new ArrayList<>();
        for (String s : Reports.lines("sentences.txt")) items.add(new String[] {"qualifySentences", s});
        if (Reports.hasAsset("tts-sentences.txt")) {
            for (String s : Reports.lines("tts-sentences.txt")) items.add(new String[] {"paradee", s});
        }
        int limit = Integer.parseInt(args.getString("limit", String.valueOf(items.size())));
        items = items.subList(0, Math.min(limit, items.size()));

        long installStart = System.nanoTime();
        JSONObject report = new JSONObject().put("device", Reports.device());
        try (QualifyVoice voice = QualifyVoice.install(context)) {
            report.put("installMs", (System.nanoTime() - installStart) / 1_000_000);
            JSONArray rows = new JSONArray();
            int edits = 0;
            int words = 0;
            double synthSeconds = 0;
            double audioSeconds = 0;
            double asrSeconds = 0;
            for (int i = 0; i < items.size(); i++) {
                String text = items.get(i)[1];
                long start = System.nanoTime();
                QualifyVoice.Audio audio = voice.synthesize(text, 1.0f);
                double seconds = (System.nanoTime() - start) / 1e9;
                synthSeconds += seconds;
                audioSeconds += audio.seconds();
                long heardStart = System.nanoTime();
                String heard = voice.transcribe(Wer.resample(audio.samples, audio.sampleRate, 16000));
                double heardSeconds = (System.nanoTime() - heardStart) / 1e9;
                asrSeconds += heardSeconds;
                int[] score = Wer.wordErrors(text, heard);
                edits += score[0];
                words += score[1];
                rows.put(new JSONObject()
                        .put("set", items.get(i)[0])
                        .put("text", text)
                        .put("phonemes", voice.phonemize(text))
                        .put("heard", heard)
                        .put("edits", score[0])
                        .put("words", score[1])
                        .put("audioSeconds", audio.seconds())
                        .put("synthSeconds", seconds)
                        .put("asrSeconds", heardSeconds));
                Log.i(TAG, String.format(Locale.ROOT, "%d/%d rtf=%.3f edits=%d | %s | %s",
                        i + 1, items.size(), seconds / audio.seconds(), score[0], text, heard));
            }
            double wer = words == 0 ? 1 : edits / (double) words;
            report.put("sentences", items.size())
                    .put("words", words)
                    .put("edits", edits)
                    .put("wer", wer)
                    .put("maxWer", maxWer)
                    .put("pass", wer <= maxWer)
                    .put("audioSeconds", audioSeconds)
                    .put("ttsRtf", synthSeconds / audioSeconds)
                    .put("asrRtf", asrSeconds / audioSeconds)
                    .put("rows", rows);
            File out = Reports.write(context, "paradee-roundtrip.json", report);
            String summary = String.format(Locale.ROOT, "WER=%.4f (%d/%d) ttsRTF=%.3f asrRTF=%.3f audio=%.1fs report=%s",
                    wer, edits, words, synthSeconds / audioSeconds, asrSeconds / audioSeconds, audioSeconds, out);
            Log.i(TAG, summary);
            Reports.status("paradee-roundtrip", summary);
            assertTrue(summary, wer <= maxWer);
        }
    }
}
