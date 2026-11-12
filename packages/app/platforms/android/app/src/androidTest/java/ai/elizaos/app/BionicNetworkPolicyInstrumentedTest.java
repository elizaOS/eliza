package ai.elizaos.app;

import static org.junit.Assert.*;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import ai.eliza.plugins.networkpolicy.NetworkPolicyReader;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BionicNetworkPolicyInstrumentedTest {
    @Test public void framedHostQueriesFreshNetworkWithoutAModelBundle() throws Exception {
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "eliza-network-proof-" + android.os.Process.myPid();
        var state = new AtomicReference<JSONObject>(NetworkPolicyReader.INSTANCE.readNetworkState(context));
        var host = new ElizaBionicInferenceServer(name, "/missing-model-bundle",
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, () -> state.get(), context.getDataDir());
        host.start();
        try {
            JSONObject initial = request(name);
            assertTrue(initial.getBoolean("ok"));
            assertEquals(state.get().toString(), initial.getJSONObject("state").toString());
            for (Object metered : new Object[] { false, true, JSONObject.NULL }) {
                state.set(new JSONObject().put("source", "android-os")
                    .put("connectionType", metered == JSONObject.NULL ? "none" : "wifi")
                    .put("metered", metered));
                JSONObject response = request(name);
                assertTrue(response.getBoolean("ok"));
                assertEquals(state.get().toString(), response.getJSONObject("state").toString());
            }
        } finally { host.stop(); }
    }

    @Test public void missingProbeIsUnavailable() throws Exception {
        String name = "eliza-network-unavailable-" + android.os.Process.myPid();
        var host = host(name, null);
        host.start();
        try { assertFalse(request(name).getBoolean("ok")); }
        finally { host.stop(); }
    }

    @Test public void bindFailureThrowsInsteadOfLookingStarted() throws Exception {
        String name = "eliza-bind-conflict-" + android.os.Process.myPid();
        var first = host(name, () -> new JSONObject().put("source", "test"));
        first.start();
        try {
            var second = host(name, null);
            assertThrows(IllegalStateException.class, second::start);
            assertTrue(request(name).getBoolean("ok"));
        } finally { first.stop(); }
    }

    @Test public void sameProcessRestartRebindsTheSocket() throws Exception {
        // A credential change stops and restarts the service in one process.
        String name = "eliza-restart-" + android.os.Process.myPid();
        for (int round = 0; round < 3; round++) {
            var host = host(name, () -> new JSONObject().put("source", "test"));
            host.start();
            try { assertTrue("round " + round, request(name).getBoolean("ok")); }
            finally { host.stop(); }
        }
    }

    @Test public void requestPathsOutsideAppStorageAreRefused() throws Exception {
        String name = "eliza-path-confinement-" + android.os.Process.myPid();
        var host = host(name, null);
        host.start();
        try {
            JSONObject response = request(name,
                "{\"op\":\"tts\",\"bundleDir\":\"/system\",\"text\":\"hi\",\"language\":\"en-US\"}");
            assertFalse(response.getBoolean("ok"));
            assertTrue(response.getString("error").contains("outside the app's model storage"));
        } finally { host.stop(); }
    }

    @Test public void oversizePromptFrameIsAnsweredNotDropped() throws Exception {
        String name = "eliza-frame-limit-" + android.os.Process.myPid();
        var host = host(name, null);
        host.start();
        try {
            String prompt = "x".repeat(ElizaBionicInferenceServer.MAX_PROMPT_FRAME_BYTES);
            JSONObject response = request(name, new JSONObject().put("op", "generate")
                .put("prompt", prompt).toString());
            assertEquals("FRAME_TOO_LARGE", response.getString("code"));
            assertEquals(ElizaBionicInferenceServer.MAX_PROMPT_FRAME_BYTES, response.getInt("limitBytes"));
        } finally { host.stop(); }
    }

    private static ElizaBionicInferenceServer host(
            String name, ElizaBionicInferenceServer.NetworkStateProbe probe) {
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return new ElizaBionicInferenceServer(name, "/missing-model-bundle",
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, probe, context.getDataDir());
    }

    private static JSONObject request(String name) throws Exception {
        return request(name, "{\"op\":\"networkPolicy\"}");
    }

    private static JSONObject request(String name, String json) throws Exception {
        try (var socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            socket.setSoTimeout(5000);
            var out = new DataOutputStream(socket.getOutputStream());
            byte[] payload = json.getBytes(StandardCharsets.UTF_8);
            out.writeInt(payload.length); out.write(payload); out.flush();
            var in = new DataInputStream(socket.getInputStream());
            int length = in.readInt();
            assertTrue(length > 0 && length < 65536);
            byte[] response = new byte[length]; in.readFully(response);
            return new JSONObject(new String(response, StandardCharsets.UTF_8));
        }
    }
}
