/** Exercises the installed app's real framed host, JNI encoder, packaged artifact and memory release. */
package ai.elizaos.app;

import static org.junit.Assert.*;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BionicEmbeddingInstrumentedTest {
    @Test public void actualHostEmbedsWithPackagedBgeAndRejectsCompleteOversizeInput() throws Exception {
        var app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(ElizaVoiceNative.ensureLoaded());
        Path root = Files.createTempDirectory(app.getCacheDir().toPath(), "bionic-embedding-proof-");
        Path text = Files.createDirectories(root.resolve("text"));
        Path model = text.resolve(BgeEmbeddingSession.MODEL);
        // The actual APK must contain this asset; no external model injection satisfies this test.
        try (var input = app.getAssets().open("agent/models/" + BgeEmbeddingSession.MODEL)) {
            Files.copy(input, model);
        }
        String name = "eliza-bge-proof-" + android.os.Process.myPid();
        ElizaBionicInferenceServer host = new ElizaBionicInferenceServer(name,
            "/intentionally-unavailable-chat-bundle", InferenceMemoryPolicy.RamClass.CONSTRAINED,
            0L, null);
        host.start();
        try {
            String input = "before\u0000after \uD83D\uDE00 café 漢字";
            JSONObject first = request(name, root.toString(), input);
            assertCanonical(first);
            JSONArray reference = first.getJSONArray("embedding");
            JSONObject prefix = request(name, root.toString(), "before");
            assertCanonical(prefix);
            assertTrue("the suffix after NUL must reach the tokenizer", first.getInt("tokens") > prefix.getInt("tokens"));
            assertDifferent(reference, prefix.getJSONArray("embedding"));
            JSONObject unicode = request(name, root.toString(), "😀 café 漢字");
            JSONObject ascii = request(name, root.toString(), "cafe");
            assertCanonical(unicode); assertCanonical(ascii);
            assertTrue("complete supplementary and CJK content must reach tokenization",
                unicode.getInt("tokens") > ascii.getInt("tokens"));
            assertDifferent(unicode.getJSONArray("embedding"), ascii.getJSONArray("embedding"));

            long[] warm = new long[30];
            for (int i = 0; i < warm.length; i++) {
                long start = System.nanoTime();
                JSONObject result = request(name, root.toString(), input);
                warm[i] = System.nanoTime() - start;
                assertCanonical(result);
                for (int d = 0; d < 384; d++) assertEquals(reference.getDouble(d), result.getJSONArray("embedding").getDouble(d), 1e-5);
            }
            JSONObject tooLarge = request(name, root.toString(), "token ".repeat(1024));
            assertFalse(tooLarge.getBoolean("ok"));
            assertEquals("EMBEDDING_INPUT_TOO_LARGE", tooLarge.getString("code"));
            host.releaseResident("instrumented-pressure-proof");
            assertCanonical(request(name, root.toString(), input));
            Path nested = Files.createDirectory(text.resolve("aaa"));
            Path other = nested.resolve("chat.gguf");
            Files.writeString(other, "alternate model");
            host.releaseResident("instrumented-artifact-revalidation");
            JSONObject rejected = request(name, root.toString(), input);
            assertFalse(rejected.getBoolean("ok"));
            assertEquals("EMBEDDING_ARTIFACT_INVALID", rejected.getString("code"));
            Files.delete(other); Files.delete(nested);
            assertCanonical(request(name, root.toString(), input));
            Arrays.sort(warm);
            Log.i("BionicEmbeddingProof", new JSONObject().put("modelSha256", BgeEmbeddingSession.SHA256)
                .put("space", BgeEmbeddingSession.SPACE).put("samples", warm.length)
                .put("medianMs", (warm[14] + warm[15]) / 2e6).put("p95Ms", warm[28] / 1e6)
                .put("tokens", first.getInt("tokens")).put("vector", reference).toString());
        } finally {
            host.stop();
            try (var files = Files.walk(root)) {
                var iterator = files.sorted(java.util.Comparator.reverseOrder()).iterator();
                while (iterator.hasNext()) Files.delete(iterator.next());
            }
        }
    }
    private static JSONObject request(String name, String bundle, String text) throws Exception {
        byte[] payload = new JSONObject().put("op", "embed").put("bundleDir", bundle)
            .put("text", text).toString().getBytes(StandardCharsets.UTF_8);
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            socket.setSoTimeout(120000);
            var out = new DataOutputStream(socket.getOutputStream());
            out.writeInt(payload.length); out.write(payload); out.flush();
            var in = new DataInputStream(socket.getInputStream());
            int size = in.readInt(); assertTrue(size > 0 && size < 1048576);
            byte[] bytes = new byte[size]; in.readFully(bytes);
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        }
    }
    private static void assertDifferent(JSONArray complete, JSONArray prefix) throws Exception {
        double squaredDistance = 0;
        for (int i = 0; i < complete.length(); i++) {
            double delta = complete.getDouble(i) - prefix.getDouble(i);
            squaredDistance += delta * delta;
        }
        assertTrue("distinct complete source must not collapse to prefix-only embedding", squaredDistance > 1e-6);
    }
    private static void assertCanonical(JSONObject response) throws Exception {
        assertTrue(response.toString(), response.getBoolean("ok"));
        assertEquals(BgeEmbeddingSession.SPACE, response.getString("embeddingSpace"));
        JSONArray vector = response.getJSONArray("embedding"); assertEquals(384, vector.length());
        double norm = 0;
        for (int i = 0; i < vector.length(); i++) {
            double value = vector.getDouble(i); assertTrue(Double.isFinite(value)); norm += value * value;
        }
        assertEquals(1.0, norm, 1e-5);
        assertTrue(response.getInt("tokens") > 0 && response.getInt("tokens") <= 512);
    }
}
