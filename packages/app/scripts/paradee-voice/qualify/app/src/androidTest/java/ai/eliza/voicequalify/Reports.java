package ai.eliza.voicequalify;

import android.content.Context;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/** Asset reading, WAV I/O and JSON reports shared by the qualify tests. */
final class Reports {
    private Reports() {}

    static Context testContext() {
        return InstrumentationRegistry.getInstrumentation().getContext();
    }

    static boolean hasAsset(String name) {
        try (InputStream ignored = testContext().getAssets().open(name)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    static List<String> lines(String asset) throws IOException {
        List<String> out = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                testContext().getAssets().open(asset), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null; ) if (!line.isBlank()) out.add(line.trim());
        }
        return out;
    }

    static String text(String asset) throws IOException {
        try (InputStream in = testContext().getAssets().open(asset)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** Mono PCM16 WAV asset to fp32; returns {samples} and checks the rate. */
    static float[] wav16k(String asset) throws IOException {
        byte[] bytes;
        try (InputStream in = testContext().getAssets().open(asset)) {
            bytes = in.readAllBytes();
        }
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        if (b.getInt(0) != 0x46464952 || b.getInt(8) != 0x45564157) throw new IOException(asset + ": not WAV");
        int offset = 12;
        int rate = 0;
        while (offset + 8 <= bytes.length) {
            int id = b.getInt(offset);
            int size = b.getInt(offset + 4);
            if (id == 0x20746d66) { // "fmt "
                if (b.getShort(offset + 8) != 1 || b.getShort(offset + 10) != 1 || b.getShort(offset + 22) != 16) {
                    throw new IOException(asset + ": need mono PCM16");
                }
                rate = b.getInt(offset + 12);
            } else if (id == 0x61746164) { // "data"
                if (rate != 16000) throw new IOException(asset + ": need 16 kHz, got " + rate);
                int n = Math.min(size, bytes.length - offset - 8) / 2;
                float[] out = new float[n];
                for (int i = 0; i < n; i++) out[i] = b.getShort(offset + 8 + i * 2) / 32768f;
                return out;
            }
            offset += 8 + size + (size & 1);
        }
        throw new IOException(asset + ": no data chunk");
    }

    static File write(Context context, String name, JSONObject report) throws Exception {
        File out = new File(context.getExternalFilesDir(null), name);
        try (FileOutputStream stream = new FileOutputStream(out)) {
            stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        return out;
    }

    static void status(String key, String summary) {
        Bundle status = new Bundle();
        status.putString(key, summary);
        InstrumentationRegistry.getInstrumentation().addResults(status);
    }

    static JSONObject device() throws Exception {
        return new JSONObject()
                .put("model", android.os.Build.MODEL)
                .put("abi", android.os.Build.SUPPORTED_ABIS[0])
                .put("api", android.os.Build.VERSION.SDK_INT);
    }
}
