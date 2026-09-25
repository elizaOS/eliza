/** Real APK-packaged Kokoro synthesis through the production framed host and JNI. */
package ai.elizaos.app;

import static org.junit.Assert.*;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Bundle;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BionicSpeechInstrumentedTest {
    private static final String IPA = "həlˈoʊ wˈɜːld";
    private static final String MODEL_HASH = "165acd9d2d9b6c2d71fa5bd52b92a2559be08567f58ed496bade076e3d9cb46c";
    private static final String VOICE_HASH = "6874670865ce984a5400afc87176706c5ed88671999c59ed0dff5dcde664277b";

    @Test public void packagedKokoroSynthesizesAndRecoversThroughFramedHost() throws Exception {
        var app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("Fused JNI library must load", ElizaVoiceNative.ensureLoaded());
        Path root = Files.createTempDirectory(app.getCacheDir().toPath(), "speech-proof-");
        Path models = Files.createDirectories(root.resolve("tts/kokoro"));
        String name = "eliza-speech-proof-" + android.os.Process.myPid();
        ElizaBionicInferenceServer host = new ElizaBionicInferenceServer(name,
            "/unavailable-chat-bundle", InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, null);
        try {
            String[] names = {"kokoro-82m-v1_0.gguf", "af_sam.bin"};
            String[] hashes = {MODEL_HASH, VOICE_HASH};
            for (int i = 0; i < names.length; i++) {
                Path file = models.resolve(names[i]);
                try (var in = app.getAssets().open("agent/models/voice/" + names[i])) { Files.copy(in, file); }
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (var in = Files.newInputStream(file)) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = in.read(buffer)) != -1) digest.update(buffer, 0, count);
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255));
                assertEquals("Pinned artifact " + names[i], hashes[i], hex.toString());
            }
            host.start();
            JSONObject first = request(name, root, IPA, "en-US", 1.0);
            float[] pcm = samples(first);
            assertTrue(pcm.length >= 2400 && pcm.length <= 240000);
            double square = 0; float peak = 0;
            for (float sample : pcm) { square += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
            double rms = Math.sqrt(square / pcm.length);
            assertTrue("Synthesis must contain audible energy", rms > 0.001 && peak > 0.01);
            JSONObject fast = request(name, root, IPA, "en-US", 1.5);
            assertTrue("Speed must affect actual duration", samples(fast).length < pcm.length);
            JSONObject empty = request(name, root, "", "en-US", 1.0);
            JSONObject language = request(name, root, IPA, "fr-FR", 1.0);
            JSONObject speed = request(name, root, IPA, "en-US", 0.0);
            JSONObject oversize = request(name, root, "a".repeat(509), "en-US", 1.0);
            for (JSONObject rejected : new JSONObject[] {empty, language, speed, oversize}) {
                assertFalse(rejected.toString(), rejected.getBoolean("ok"));
                assertFalse("Failure must not fabricate audio", rejected.has("pcmBase64"));
            }
            host.releaseResident("speech-proof-reload");
            JSONObject recovered = request(name, root, IPA, "en-US", 1.0);
            assertTrue("Synthesis must recover after invalid calls and release", samples(recovered).length >= 2400);
            JSONObject proof = new JSONObject().put("modelSha256", MODEL_HASH).put("voiceSha256", VOICE_HASH)
                .put("ipa", IPA).put("first", first).put("fastSamples", fast.getInt("samples"))
                .put("rms", rms).put("peak", peak).put("empty", empty).put("language", language)
                .put("speed", speed).put("oversize", oversize).put("recoveredSamples", recovered.getInt("samples"));
            export("bionic-speech-proof.json", proof.toString().getBytes(StandardCharsets.UTF_8));
            export("bionic-speech.wav", wav(pcm));
        } finally {
            host.stop();
            try (var files = Files.walk(root)) {
                var iterator = files.sorted(java.util.Comparator.reverseOrder()).iterator();
                while (iterator.hasNext()) Files.delete(iterator.next());
            }
        }
    }

    private static float[] samples(JSONObject result) throws Exception {
        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals(24000, result.getInt("sampleRate"));
        byte[] data = Base64.decode(result.getString("pcmBase64"), Base64.DEFAULT);
        assertEquals(result.getInt("samples") * 4, data.length);
        float[] pcm = new float[data.length / 4];
        ByteBuffer buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < pcm.length; i++) {
            pcm[i] = buffer.getFloat(); assertTrue("PCM must be finite", Float.isFinite(pcm[i]));
        }
        return pcm;
    }
    private static JSONObject request(String name, Path root, String ipa, String language, double speed) throws Exception {
        byte[] payload = new JSONObject().put("op", "tts").put("bundleDir", root.toString())
            .put("ipa", ipa).put("language", language).put("speed", speed).toString().getBytes(StandardCharsets.UTF_8);
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            socket.setSoTimeout(120000);
            var out = new DataOutputStream(socket.getOutputStream());
            out.writeInt(payload.length); out.write(payload); out.flush();
            var in = new DataInputStream(socket.getInputStream());
            int size = in.readInt(); assertTrue(size > 0 && size < 4 * 1048576);
            byte[] bytes = new byte[size]; in.readFully(bytes);
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        }
    }
    private static byte[] wav(float[] pcm) {
        ByteBuffer out = ByteBuffer.allocate(44 + pcm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length * 2);
        out.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        out.putInt(24000).putInt(48000).putShort((short) 2).putShort((short) 16);
        out.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length * 2);
        for (float sample : pcm) out.putShort((short) Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
        return out.array();
    }
    private static void export(String name, byte[] bytes) {
        Bundle status = new Bundle(); status.putString("nativeArtifactName", name);
        status.putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
    }
}
