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
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, () -> state.get());
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
        var host = new ElizaBionicInferenceServer(name, "/missing-model-bundle",
            InferenceMemoryPolicy.RamClass.CONSTRAINED, 0L, null, null);
        host.start();
        try { assertFalse(request(name).getBoolean("ok")); }
        finally { host.stop(); }
    }

    private static JSONObject request(String name) throws Exception {
        try (var socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            socket.setSoTimeout(5000);
            var out = new DataOutputStream(socket.getOutputStream());
            byte[] payload = "{\"op\":\"networkPolicy\"}".getBytes(StandardCharsets.UTF_8);
            out.writeInt(payload.length); out.write(payload); out.flush();
            var in = new DataInputStream(socket.getInputStream());
            int length = in.readInt();
            assertTrue(length > 0 && length < 65536);
            byte[] response = new byte[length]; in.readFully(response);
            return new JSONObject(new String(response, StandardCharsets.UTF_8));
        }
    }
}
