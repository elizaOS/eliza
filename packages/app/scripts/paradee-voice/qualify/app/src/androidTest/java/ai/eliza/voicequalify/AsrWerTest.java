package ai.eliza.voicequalify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Native Phonon-2 ASR of the :paradee-voice bundle on pinned human speech: the
 * 100 LibriSpeech test-clean utterances and speech-fixture 0.wav that
 * `host-wer-gate.ts --export-device-fixtures <dir>` writes (pass the dir as
 * -PasrFixturesDir). Pass: corpus WER <= 0.06 and an empty transcript for
 * 3 s of digital silence, as on the host. Instrumentation arguments: maxWer,
 * limit. Report: Android/data/ai.eliza.voicequalify/files/asr-wer.json.
 */
@RunWith(AndroidJUnit4.class)
public class AsrWerTest {
    private static final String TAG = "AsrWer";

    @Test
    public void nativeAsrMeetsWerOnPinnedSpeech() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bundle args = InstrumentationRegistry.getArguments();
        double maxWer = Double.parseDouble(args.getString("maxWer", String.valueOf(Wer.ASR_MAX_WER)));
        assertTrue("asr-fixtures.json missing: build with -PasrFixturesDir=<host-wer-gate --export-device-fixtures dir>",
                Reports.hasAsset("asr-fixtures.json"));
        JSONArray items = new JSONObject(Reports.text("asr-fixtures.json")).getJSONArray("items");
        int limit = Integer.parseInt(args.getString("limit", String.valueOf(items.length())));
        JSONObject report = new JSONObject().put("device", Reports.device());
        try (QualifyVoice voice = QualifyVoice.install(context)) {
            String silence = voice.transcribe(new float[3 * 16000]);
            report.put("silenceHeard", silence);
            JSONArray rows = new JSONArray();
            int edits = 0;
            int words = 0;
            double audioSeconds = 0;
            double asrSeconds = 0;
            int count = Math.min(limit, items.length());
            for (int i = 0; i < count; i++) {
                JSONObject item = items.getJSONObject(i);
                float[] pcm = Reports.wav16k(item.getString("file"));
                long start = System.nanoTime();
                String heard = voice.transcribe(pcm);
                double seconds = (System.nanoTime() - start) / 1e9;
                asrSeconds += seconds;
                audioSeconds += pcm.length / 16000.0;
                int[] score = Wer.wordErrors(item.getString("text"), heard);
                edits += score[0];
                words += score[1];
                rows.put(new JSONObject()
                        .put("id", item.getString("id"))
                        .put("set", item.optString("set"))
                        .put("heard", heard)
                        .put("edits", score[0])
                        .put("words", score[1])
                        .put("audioSeconds", pcm.length / 16000.0)
                        .put("asrSeconds", seconds));
                Log.i(TAG, String.format(Locale.ROOT, "%d/%d %s edits=%d/%d rtf=%.3f",
                        i + 1, count, item.getString("id"), score[0], score[1], seconds / (pcm.length / 16000.0)));
            }
            double wer = words == 0 ? 1 : edits / (double) words;
            boolean silencePass = Wer.normalize(silence).isEmpty();
            report.put("utterances", count)
                    .put("words", words)
                    .put("edits", edits)
                    .put("wer", wer)
                    .put("maxWer", maxWer)
                    .put("silencePass", silencePass)
                    .put("pass", wer <= maxWer && silencePass)
                    .put("audioSeconds", audioSeconds)
                    .put("asrRtf", asrSeconds / audioSeconds)
                    .put("rows", rows);
            File out = Reports.write(context, "asr-wer.json", report);
            String summary = String.format(Locale.ROOT, "WER=%.4f (%d/%d) asrRTF=%.3f silence=%s report=%s",
                    wer, edits, words, asrSeconds / audioSeconds, silencePass ? "empty" : "\"" + silence + "\"", out);
            Log.i(TAG, summary);
            Reports.status("asr-wer", summary);
            assertEquals("silence must give an empty transcript", "", String.join(" ", Wer.normalize(silence)));
            assertTrue(summary, wer <= maxWer);
        }
    }
}
