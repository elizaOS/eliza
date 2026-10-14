/** Real Paradee transport/PCM diagnostics. Passing does not qualify intelligible speech. */
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
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BionicSpeechInstrumentedTest {
    private static final String TEXT = "Hello world.";
    /** misaki spelling of TEXT; exercises the phonemes path without G2P. */
    private static final String PHONEMES = "həlˈO wˈɜɹld.";
    // Pinned by paradee-voice/inputs.json (= fork tools/paradee and tools/misaki-g2p pins.json).
    private static final String MODEL_HASH = "9a18ae710211fab04129e00bc0cde04484c0cf8d80bb19e51df7e331ae83a254";
    private static final String LEXICON_HASH = "fbf09090cff0a41f3f579bf03ab9fc42710b04d7284767b10467a5f182c23925";

    @Test public void packagedParadeeProducesDiagnosticPcmAndRecoversThroughFramedHost() throws Exception {
        var app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("Fused JNI library must load", ElizaVoiceNative.ensureLoaded());
        assertEquals(1, ElizaVoiceNative.nativeParadeeSupported());
        Path root = Files.createTempDirectory(app.getCacheDir().toPath(), "speech-proof-");
        Path models = Files.createDirectories(root.resolve(ElizaBionicInferenceServer.PARADEE_DIR));
        String name = "eliza-speech-proof-" + android.os.Process.myPid();
        ElizaBionicInferenceServer host = new ElizaBionicInferenceServer(name,
            "/unavailable-chat-bundle", InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, null);
        try {
            String[] names = {ElizaBionicInferenceServer.PARADEE_MODEL, ElizaBionicInferenceServer.MISAKI_LEXICON};
            String[] hashes = {MODEL_HASH, LEXICON_HASH};
            for (int i = 0; i < names.length; i++) {
                Path file = models.resolve(names[i]);
                try (var in = app.getAssets().open("agent/models/voice/" + names[i])) { Files.copy(in, file); }
                assertEquals("Pinned artifact " + names[i], hashes[i], sha256(file));
            }
            host.start();
            JSONObject first = request(name, tts(root, TEXT, null, "en-US", 1.0));
            float[] pcm = samples(first);
            assertTrue(pcm.length >= 2400 && pcm.length <= 240000);
            double square = 0; float peak = 0;
            for (float sample : pcm) { square += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
            double rms = Math.sqrt(square / pcm.length);
            assertTrue("Synthesis must contain audible energy", rms > 0.001 && peak > 0.01);
            JSONObject fast = request(name, tts(root, TEXT, null, "en-US", 1.5));
            assertTrue("Speed must affect actual duration", samples(fast).length < pcm.length);
            JSONObject phonemes = request(name, tts(root, "", PHONEMES, "en-US", 1.0));
            assertTrue("Phoneme input must speak", samples(phonemes).length >= 2400);
            // There is no phrase cap: long text is chunked natively.
            String paragraph = (TEXT + " The quick brown fox jumps over the lazy dog. ").repeat(12);
            JSONObject longText = request(name, tts(root, paragraph, null, "en-US", 1.0));
            assertTrue("Long text must be spoken whole", samples(longText).length > 10 * pcm.length);

            JSONObject empty = request(name, tts(root, "", null, "en-US", 1.0));
            JSONObject language = request(name, tts(root, TEXT, null, "fr-FR", 1.0));
            JSONObject speed = request(name, tts(root, TEXT, null, "en-US", 0.0));
            for (JSONObject rejected : new JSONObject[] {empty, language, speed}) {
                assertFalse(rejected.toString(), rejected.getBoolean("ok"));
                assertFalse("Failure must not fabricate audio", rejected.has("pcmBase64"));
            }

            // tts_cancel on a second connection stops a running synthesis.
            AtomicReference<JSONObject> cancelled = new AtomicReference<>();
            Thread speaker = new Thread(() -> {
                try { cancelled.set(request(name, tts(root, paragraph.repeat(4), null, "en-US", 1.0))); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            speaker.start();
            Thread.sleep(150);
            JSONObject signal = request(name, new JSONObject().put("op", "tts_cancel"));
            assertTrue(signal.toString(), signal.getBoolean("ok"));
            speaker.join(120000);
            assertEquals(cancelled.get().toString(), "CANCELLED", cancelled.get().optString("code"));
            assertFalse("Cancel must not return audio", cancelled.get().has("pcmBase64"));
            assertTrue("Synthesis must work after a cancel",
                samples(request(name, tts(root, TEXT, null, "en-US", 1.0))).length >= 2400);

            // onTrimMemory evicts the TTS weights; the next call reloads them.
            host.evictVoiceRegions("speech-proof-trim");
            assertTrue("Synthesis must recover after an evict",
                samples(request(name, tts(root, TEXT, null, "en-US", 1.0))).length >= 2400);
            host.releaseResident("speech-proof-reload");
            JSONObject recovered = request(name, tts(root, TEXT, null, "en-US", 1.0));
            assertTrue("Synthesis must recover after invalid calls and release", samples(recovered).length >= 2400);
            JSONObject proof = new JSONObject().put("modelSha256", MODEL_HASH).put("lexiconSha256", LEXICON_HASH)
                .put("scope", "native transport and PCM diagnostics").put("intelligibility", "unqualified")
                .put("text", TEXT).put("first", first.put("pcmBase64", "(omitted)"))
                .put("fastSamples", fast.getInt("samples")).put("longSamples", longText.getInt("samples"))
                .put("rms", rms).put("peak", peak).put("empty", empty).put("language", language)
                .put("speed", speed).put("cancelled", cancelled.get())
                .put("recoveredSamples", recovered.getInt("samples"));
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

    private static String sha256(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var in = Files.newInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = in.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255));
        return hex.toString();
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
    private static JSONObject tts(Path root, String text, String phonemes, String language, double speed) throws Exception {
        JSONObject request = new JSONObject().put("op", "tts").put("bundleDir", root.toString())
            .put("text", text).put("language", language).put("speed", speed);
        return phonemes == null ? request : request.put("phonemes", phonemes);
    }
    private static JSONObject request(String name, JSONObject request) throws Exception {
        byte[] payload = request.toString().getBytes(StandardCharsets.UTF_8);
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            socket.setSoTimeout(120000);
            var out = new DataOutputStream(socket.getOutputStream());
            out.writeInt(payload.length); out.write(payload); out.flush();
            var in = new DataInputStream(socket.getInputStream());
            int size = in.readInt(); assertTrue(size > 0 && size < 64 * 1048576);
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
