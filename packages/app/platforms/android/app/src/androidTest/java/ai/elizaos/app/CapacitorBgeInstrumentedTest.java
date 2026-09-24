/** Exercises the installed WebView's registered BGE API, packaged model, JNI token admission and context release. */
package ai.elizaos.app;

import static org.junit.Assert.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CapacitorBgeInstrumentedTest {
    private static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result);
            finished.countDown();
        }));
        assertTrue("WebView evaluation did not finish", finished.await(10, TimeUnit.SECONDS));
        return value.get();
    }

    @Test public void registeredBridgeEmbedsAndRejectsMismatchedAdmission() throws Exception {
        var app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Path root = Files.createTempDirectory(app.getCacheDir().toPath(), "capacitor-bge-proof-");
        Path model = root.resolve(BgeEmbeddingSession.MODEL);
        try (var input = app.getAssets().open("agent/models/" + BgeEmbeddingSession.MODEL)) {
            Files.copy(input, model);
        }
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            long readyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
            boolean ready = false;
            while (System.nanoTime() < readyDeadline) {
                if ("true".equals(evaluate(scenario, "Boolean(window.Capacitor && typeof window.Capacitor.registerPlugin === 'function' && window.Capacitor.isPluginAvailable('ElizaBge'))"))) {
                    ready = true;
                    break;
                }
                Thread.sleep(100);
            }
            assertTrue("The installed WebView did not receive the ElizaBge plugin header", ready);
            String script = "window.__elizaBgeProof = null; (async () => {"
                + "const bridge = window.Capacitor.registerPlugin('ElizaBge');"
                + "const context = await bridge.initBgeEmbedding({model:" + JSONObject.quote(model.toString()) + ",contextSize:512});"
                + "const args = {contextId:context.contextId,text:'[CLS] [MASK] [SEP]',expectedTokenIds:[101,101,103,102,102],embeddingSpace:" + JSONObject.quote(BgeEmbeddingSession.SPACE) + "};"
                + "try {"
                + "const tokens = await bridge.tokenizeBge(args);"
                + "const vector = await bridge.embedBge(args);"
                + "let mismatch = null; try { await bridge.embedBge({...args,expectedTokenIds:[101,100,103,102,102]}); } catch (error) { mismatch = error.code; }"
                + "window.__elizaBgeProof = {ok:true,tokens:tokens.tokens,vector,mismatch};"
                + "} finally { await bridge.releaseBge({contextId:context.contextId}); }"
                + "let released = null; try { await bridge.embedBge(args); } catch (error) { released = error.code; }"
                + "window.__elizaBgeProof.released = released;"
                + "window.__elizaBgeProof.finished = true;"
                + "})().catch(error => { window.__elizaBgeProof = {finished:true,ok:false,error:String(error),code:error.code}; });";
            evaluate(scenario, script);
            JSONObject result = null;
            long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(2);
            while (System.nanoTime() < deadline) {
                String encoded = evaluate(scenario, "JSON.stringify(window.__elizaBgeProof)");
                if (encoded != null && !"null".equals(encoded)) {
                    String payload = new JSONArray("[" + encoded + "]").getString(0);
                    if (!"null".equals(payload)) {
                        JSONObject current = new JSONObject(payload);
                        if (current.optBoolean("finished")) { result = current; break; }
                    }
                }
                Thread.sleep(100);
            }
            assertNotNull("The native bridge did not finish its real encoder calls", result);
            assertTrue(result.toString(), result.getBoolean("ok"));
            assertEquals("[101,101,103,102,102]", result.getJSONArray("tokens").toString());
            assertEquals("EMBEDDING_TOKENIZER_MISMATCH", result.getString("mismatch"));
            assertEquals("EMBEDDING_CONTEXT_UNAVAILABLE", result.getString("released"));
            JSONObject vector = result.getJSONObject("vector");
            assertEquals(BgeEmbeddingSession.SPACE, vector.getString("embeddingSpace"));
            assertEquals(result.getJSONArray("tokens").toString(), vector.getJSONArray("tokenIds").toString());
            JSONArray values = vector.getJSONArray("embedding");
            assertEquals(384, values.length());
            double norm = 0;
            for (int i = 0; i < values.length(); i++) {
                double value = values.getDouble(i);
                assertTrue(Double.isFinite(value));
                norm += value * value;
            }
            assertEquals(1.0, norm, 1e-5);
        } finally {
            try (var files = Files.walk(root)) {
                var iterator = files.sorted(java.util.Comparator.reverseOrder()).iterator();
                while (iterator.hasNext()) Files.delete(iterator.next());
            }
        }
    }
}
