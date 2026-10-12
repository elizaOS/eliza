package ai.eliza.voicequalify;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.kokoro.KokoroAssets;
import ai.eliza.kokoro.KokoroVoice;
import ai.eliza.speech.LocalSpeechEngine;
import ai.eliza.speech.LocalSpeechEngineHolder;
import ai.eliza.speech.LocalTranscriber;
import ai.eliza.speech.SpeechAssets;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Speaks each sentence with Kokoro on the device, then hears it again with
 * Whisper tiny.en, and reports word error rate (WER) and real-time factor
 * (RTF = synthesis time / audio time). No network or agent is used.
 *
 * Instrumentation arguments: maxWer (default 0.10); voice, another preset
 * file on the device; limit, the first N sentences only; kokoroEnv, for
 * example "KOKORO_PROFILE=1,KOKORO_NUM_THREADS=4" for phase timings in logcat.
 */
@RunWith(AndroidJUnit4.class)
public class KokoroRoundTripTest {
    private static final String TAG = "KokoroRoundTrip";

    @Test
    public void kokoroSpeechIsHeardByWhisper() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Bundle args = InstrumentationRegistry.getArguments();
        double maxWer = Double.parseDouble(args.getString("maxWer", "0.10"));
        List<String> sentences = readSentences();
        int limit = Integer.parseInt(args.getString("limit", String.valueOf(sentences.size())));
        sentences = sentences.subList(0, Math.min(limit, sentences.size()));
        // Kokoro reads these once, at its first synthesis in this process.
        for (String pair : args.getString("kokoroEnv", "").split(",")) {
            int split = pair.indexOf('=');
            if (split > 0) android.system.Os.setenv(pair.substring(0, split), pair.substring(split + 1), true);
        }

        long installStart = System.nanoTime();
        KokoroAssets.Bundle kokoro = KokoroAssets.install(context);
        File whisperDir = SpeechAssets.install(context);
        long installMs = (System.nanoTime() - installStart) / 1_000_000;

        File voiceFile = args.getString("voice") == null ? kokoro.voice : new File(args.getString("voice"));
        JSONObject report = new JSONObject()
                .put("device", android.os.Build.MODEL + " / " + android.os.Build.SUPPORTED_ABIS[0] + " / API " + android.os.Build.VERSION.SDK_INT)
                .put("voice", voiceFile.getName())
                .put("installMs", installMs)
                .put("onDeviceRecognizer", LocalTranscriber.onDeviceAvailable(context))
                .put("kokoroEnv", args.getString("kokoroEnv", ""));

        try (LocalSpeechEngineHolder whisper = new LocalSpeechEngineHolder(() -> new LocalSpeechEngine(whisperDir))) {
            long loadStart = System.nanoTime();
            KokoroVoice voice = new KokoroVoice(kokoro.model, voiceFile, kokoro.espeakRoot);
            report.put("kokoroLoadMs", (System.nanoTime() - loadStart) / 1_000_000);
            LocalTranscriber transcriber = new LocalTranscriber(context, whisper);
            JSONArray rows = new JSONArray();
            int edits = 0;
            int words = 0;
            double synthSeconds = 0;
            double audioSeconds = 0;
            try {
                for (int i = 0; i < sentences.size(); i++) {
                    String text = sentences.get(i);
                    String[] phonemes = voice.phonemize(text);
                    long start = System.nanoTime();
                    KokoroVoice.Audio audio = voice.synthesize(text, 1.0f);
                    double seconds = (System.nanoTime() - start) / 1e9;
                    synthSeconds += seconds;
                    audioSeconds += audio.seconds();
                    float[] mono16k = to16k(audio.samples, audio.sampleRate);
                    long heardStart = System.nanoTime();
                    LocalTranscriber.Result heard = transcriber.transcribe(mono16k);
                    long heardMs = (System.nanoTime() - heardStart) / 1_000_000;
                    int[] score = wordErrors(text, heard.text);
                    edits += score[0];
                    words += score[1];
                    if (i < 3) writeWav(context, "kokoro-" + i + ".wav", audio);
                    rows.put(new JSONObject()
                            .put("text", text)
                            .put("phonemes", new JSONArray(phonemes))
                            .put("heard", heard.text)
                            .put("backend", heard.backend.name())
                            .put("edits", score[0])
                            .put("words", score[1])
                            .put("audioSeconds", audio.seconds())
                            .put("synthSeconds", seconds)
                            .put("transcribeMs", heardMs));
                    Log.i(TAG, String.format(Locale.ROOT, "%d/%d rtf=%.2f edits=%d %s | %s | %s",
                            i + 1, sentences.size(), seconds / audio.seconds(), score[0], heard.backend, text, heard.text));
                }
            } finally {
                voice.close();
            }
            double wer = edits / (double) words;
            report.put("sampleRate", voice.sampleRate())
                    .put("sentences", sentences.size())
                    .put("words", words)
                    .put("edits", edits)
                    .put("wer", wer)
                    .put("audioSeconds", audioSeconds)
                    .put("synthSeconds", synthSeconds)
                    .put("rtf", synthSeconds / audioSeconds)
                    .put("rows", rows);
            File out = new File(context.getExternalFilesDir(null), "kokoro-roundtrip.json");
            try (FileOutputStream stream = new FileOutputStream(out)) {
                stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            String summary = String.format(Locale.ROOT, "WER=%.3f (%d/%d) RTF=%.2f audio=%.1fs voice=%s report=%s",
                    wer, edits, words, synthSeconds / audioSeconds, audioSeconds, voiceFile.getName(), out);
            Log.i(TAG, summary);
            Bundle status = new Bundle();
            status.putString("kokoro-roundtrip", summary);
            InstrumentationRegistry.getInstrumentation().sendStatus(0, status);
            assertTrue(summary, wer <= maxWer);
        }
    }

    private static List<String> readSentences() throws Exception {
        List<String> out = new ArrayList<>();
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(test.getAssets().open("sentences.txt"), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null; ) if (!line.isBlank()) out.add(line.trim());
        }
        return out;
    }

    /** Windowed-sinc resampler (Hann, 16 zero crossings) for Kokoro 24 kHz to Whisper 16 kHz. */
    static float[] to16k(float[] input, int rate) {
        if (rate == 16000) return input;
        double ratio = rate / 16000.0;
        double cutoff = Math.min(1.0, 16000.0 / rate) * 0.97;
        int half = 16;
        int count = (int) Math.floor(input.length / ratio);
        float[] out = new float[count];
        for (int n = 0; n < count; n++) {
            double center = n * ratio;
            int first = (int) Math.ceil(center - half / cutoff);
            int last = (int) Math.floor(center + half / cutoff);
            double sum = 0;
            for (int k = Math.max(0, first); k <= Math.min(input.length - 1, last); k++) {
                double x = (k - center) * cutoff;
                double sinc = x == 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
                double window = 0.5 + 0.5 * Math.cos(Math.PI * x / half);
                sum += input[k] * cutoff * sinc * window;
            }
            out[n] = (float) Math.max(-1, Math.min(1, sum));
        }
        return out;
    }

    private static List<String> words(String text) {
        List<String> out = new ArrayList<>();
        for (String word : text.toLowerCase(Locale.ROOT).replace('-', ' ').replaceAll("[^a-z0-9' ]", " ").trim().split("\\s+")) {
            if (!word.isEmpty()) out.add(word);
        }
        return out;
    }

    /** {edits, reference words}: word-level Levenshtein distance. */
    static int[] wordErrors(String reference, String hypothesis) {
        List<String> ref = words(reference);
        List<String> hyp = words(hypothesis);
        int[] row = new int[hyp.size() + 1];
        for (int j = 0; j <= hyp.size(); j++) row[j] = j;
        for (int i = 1; i <= ref.size(); i++) {
            int previous = row[0];
            row[0] = i;
            for (int j = 1; j <= hyp.size(); j++) {
                int current = Math.min(Math.min(row[j] + 1, row[j - 1] + 1),
                        previous + (ref.get(i - 1).equals(hyp.get(j - 1)) ? 0 : 1));
                previous = row[j];
                row[j] = current;
            }
        }
        return new int[] {row[hyp.size()], ref.size()};
    }

    private static void writeWav(Context context, String name, KokoroVoice.Audio audio) throws Exception {
        java.nio.ByteBuffer wav = java.nio.ByteBuffer.allocate(44 + audio.samples.length * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + audio.samples.length * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(audio.sampleRate).putInt(audio.sampleRate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(audio.samples.length * 2);
        for (float sample : audio.samples) wav.putShort((short) Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
        try (FileOutputStream stream = new FileOutputStream(new File(context.getExternalFilesDir(null), name))) {
            stream.write(wav.array());
        }
    }
}
