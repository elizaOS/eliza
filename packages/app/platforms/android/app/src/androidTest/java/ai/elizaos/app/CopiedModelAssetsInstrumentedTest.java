package ai.elizaos.app;

import static org.junit.Assert.*;

import ai.eliza.voice.VoiceBundleAssets;
import android.content.Context;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Debug;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real APK AssetManager, production voice installer, service copy path and BGE loader validation. */
@RunWith(AndroidJUnit4.class)
public final class CopiedModelAssetsInstrumentedTest {
    @Test public void extractsExactModelsAndReusesPrivateFiles() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File voice = VoiceBundleAssets.bundleRoot(context);
        assertFalse("Run on a cleared disposable installation", voice.exists());
        JSONObject manifest;
        try (var input = context.getAssets().open(VoiceBundleAssets.ASSET_ROOT + "/manifest.json")) {
            manifest = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
        long voiceCpu = Debug.threadCpuTimeNanos(), voiceStart = SystemClock.elapsedRealtimeNanos();
        VoiceBundleAssets.install(context);
        long voiceWall = SystemClock.elapsedRealtimeNanos() - voiceStart;
        voiceCpu = Debug.threadCpuTimeNanos() - voiceCpu;
        JSONArray verified = new JSONArray();
        JSONArray entries = manifest.getJSONArray("files");
        long[] modified = new long[entries.length()];
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            File file = new File(voice, entry.getString("path"));
            assertEquals(entry.getLong("bytes"), file.length());
            assertEquals(entry.getString("sha256"), sha256(file));
            modified[i] = file.lastModified();
            verified.put(new JSONObject().put("path", entry.getString("path"))
                .put("bytes", file.length()).put("sha256", sha256(file)));
        }

        // This is the actual resident service's aux-model extraction method, in an isolated
        // private directory. It does not start the service, runtime, microphone or inference.
        File privateRoot = new File(context.getNoBackupFilesDir(), "model-copy-qualification");
        assertFalse("Run on a cleared disposable installation", privateRoot.exists());
        File files = new File(privateRoot, "files"), state = new File(files, ".eliza");
        assertTrue(state.mkdirs());
        Method extract = ElizaAgentService.class.getDeclaredMethod("extractAuxRuntimeAssets",
            AssetManager.class, File.class, File.class, boolean.class);
        extract.setAccessible(true);
        ElizaAgentService service = new ElizaAgentService();
        long bgeCpu = Debug.threadCpuTimeNanos(), bgeStart = SystemClock.elapsedRealtimeNanos();
        extract.invoke(service, context.getAssets(), files, state, false);
        long bgeWall = SystemClock.elapsedRealtimeNanos() - bgeStart;
        bgeCpu = Debug.threadCpuTimeNanos() - bgeCpu;
        File bge = new File(state, "local-inference/models/" + BgeEmbeddingSession.MODEL);
        assertEquals(67_308_128, bge.length());
        assertEquals(BgeEmbeddingSession.SHA256, sha256(bge));
        long bgeModified = bge.lastModified();
        File bundle = new File(privateRoot, "bge-bundle"), text = new File(bundle, "text");
        assertTrue(text.mkdirs());
        Files.createLink(new File(text, BgeEmbeddingSession.MODEL).toPath(), bge.toPath());
        assertEquals(bundle.getCanonicalPath(), BgeEmbeddingSession.verifyBundle(bundle.getPath()));

        JSONArray voiceWarm = new JSONArray(), bgeWarm = new JSONArray();
        for (int i = 0; i < 5; i++) {
            long start = SystemClock.elapsedRealtimeNanos();
            VoiceBundleAssets.install(context);
            voiceWarm.put(SystemClock.elapsedRealtimeNanos() - start);
            start = SystemClock.elapsedRealtimeNanos();
            extract.invoke(service, context.getAssets(), files, state, false);
            bgeWarm.put(SystemClock.elapsedRealtimeNanos() - start);
        }
        for (int i = 0; i < entries.length(); i++)
            assertEquals(modified[i], new File(voice, entries.getJSONObject(i).getString("path")).lastModified());
        assertEquals(bgeModified, bge.lastModified());
        assertEquals(BgeEmbeddingSession.SHA256, sha256(bge));
        // A wrong-size voice cache entry is repaired from the actual AssetManager source.
        File vad = new File(voice, "vad/silero-vad-v5.gguf");
        String vadHash = sha256(vad);
        try (var corrupt = new java.io.RandomAccessFile(vad, "rw")) { corrupt.setLength(1); }
        VoiceBundleAssets.install(context);
        assertEquals(vadHash, sha256(vad));
        // The BGE loader refuses corrupted private bytes before constructing a native context.
        try (var corrupt = new java.io.RandomAccessFile(bge, "rw")) { corrupt.setLength(1); }
        BgeEmbeddingSession.Failure corruptBge = assertThrows(BgeEmbeddingSession.Failure.class,
            () -> BgeEmbeddingSession.verifyBundle(bundle.getPath()));
        assertEquals("EMBEDDING_ARTIFACT_INVALID", corruptBge.code);
        Files.delete(new File(text, BgeEmbeddingSession.MODEL).toPath());
        Files.delete(bge.toPath());
        extract.invoke(service, context.getAssets(), files, state, false);
        Files.createLink(new File(text, BgeEmbeddingSession.MODEL).toPath(), bge.toPath());
        assertEquals(bundle.getCanonicalPath(), BgeEmbeddingSession.verifyBundle(bundle.getPath()));
        JSONObject result = new JSONObject()
            .put("scope", "APK extraction and warm file reuse; no full-app startup or inference measurement")
            .put("package", context.getPackageName()).put("fingerprint", Build.FINGERPRINT)
            .put("voiceFiles", verified).put("bgeBytes", bge.length()).put("bgeSha256", sha256(bge))
            .put("voiceFirstExtractionWallNanos", voiceWall).put("voiceFirstExtractionThreadCpuNanos", voiceCpu)
            .put("bgeAuxFirstExtractionWallNanos", bgeWall).put("bgeAuxFirstExtractionThreadCpuNanos", bgeCpu)
            .put("voiceWarmWallNanos", voiceWarm).put("bgeAuxWarmWallNanos", bgeWarm)
            .put("truncatedVoiceRepaired", true).put("corruptBgeRejectedThenRecopied", true);
        try (var output = new FileOutputStream(new File(context.getFilesDir(), "model-copy-qualification.json"))) {
            output.write(result.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] block = new byte[65536];
            for (int count; (count = input.read(block)) != -1;) digest.update(block, 0, count);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }
}
