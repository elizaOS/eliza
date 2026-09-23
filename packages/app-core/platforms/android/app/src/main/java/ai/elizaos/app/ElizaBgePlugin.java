/** Exposes the verified fused BGE session to Capacitor without loading a second native inference library. */
package ai.elizaos.app;

import com.getcapacitor.Plugin;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;

@CapacitorPlugin(name = "ElizaBge")
public final class ElizaBgePlugin extends Plugin {
    private final ExecutorService encoderQueue = Executors.newSingleThreadExecutor();
    private final Map<Integer, Encoder> encoders = new HashMap<>();
    private int nextEncoderId = 1;

    private static final class Encoder {
        final BgeEmbeddingSession session = new BgeEmbeddingSession();
        final String bundle;
        final int limit;
        Encoder(String bundle, int limit) { this.bundle = bundle; this.limit = limit; }
    }

    private interface Operation { void run() throws Exception; }

    private void submit(PluginCall call, Operation operation) {
        try {
            encoderQueue.execute(() -> {
                try {
                    operation.run();
                } catch (BgeEmbeddingSession.Failure error) {
                    // error-policy:J1 Preserve encoder admission failures at the Capacitor boundary.
                    call.reject(error.getMessage(), error.code);
                } catch (Exception | LinkageError error) {
                    // error-policy:J1 Missing native ABI and transport failures reject the JS promise.
                    call.reject(error.toString(), "EMBEDDING_BACKEND_UNAVAILABLE");
                }
            });
        } catch (RejectedExecutionException error) {
            // error-policy:J1 Calls after app teardown cannot claim an active encoder.
            call.reject("The embedding transport has closed", "EMBEDDING_BACKEND_UNAVAILABLE");
        }
    }

    private static String requiredString(PluginCall call, String field) {
        String value = call.getString(field);
        if (value == null) throw new BgeEmbeddingSession.Failure("EMBEDDING_INPUT_INVALID", field + " is required");
        BgeEmbeddingSession.completeUtf8(value);
        return value;
    }

    private Encoder encoder(PluginCall call) {
        Integer id = call.getInt("contextId");
        Encoder encoder = id == null ? null : encoders.get(id);
        if (encoder == null) throw new BgeEmbeddingSession.Failure("EMBEDDING_CONTEXT_UNAVAILABLE", "Open the BGE encoder before embedding");
        return encoder;
    }

    @PluginMethod public void initBgeEmbedding(PluginCall call) {
        submit(call, () -> {
            if (encoders.size() >= 10) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_CONTEXT_UNAVAILABLE", "Release an encoder before allocating another context");
            }
            String model = requiredString(call, "model");
            if (model.indexOf('\0') >= 0 || !new File(model).isAbsolute()) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_ARTIFACT_INVALID", "An absolute BGE model path without NUL is required");
            }
            Integer limit = call.getInt("contextSize");
            if (limit == null || limit < 3 || limit > 512) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_CONTEXT_INVALID", "BGE contextSize must be between 3 and 512");
            }
            Path source = new File(model).getCanonicalFile().toPath();
            if (!Files.isRegularFile(source) || !source.getFileName().toString().equals(BgeEmbeddingSession.MODEL)) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_ARTIFACT_INVALID", "Install the pinned BGE GGUF before opening its encoder");
            }
            // Reuse the Bionic bundle view; this alias contains no second copy of model bytes.
            Path bundle = new File(source.toString() + ".embedding.bundle").toPath();
            Path text = Files.createDirectories(bundle.resolve("text"));
            Path target = text.resolve(BgeEmbeddingSession.MODEL);
            if (!Files.exists(target)) Files.createSymbolicLink(target, source);
            if (!target.toRealPath().equals(source)) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_ARTIFACT_INVALID", "BGE bundle alias does not reference the requested artifact");
            }
            if (!ElizaVoiceNative.ensureLoaded()) {
                throw new BgeEmbeddingSession.Failure("EMBEDDING_BACKEND_UNAVAILABLE", "Install the fused native BGE library");
            }
            Encoder encoder = new Encoder(bundle.toString(), limit);
            encoder.session.open(encoder.bundle, encoder.limit);
            int id = nextEncoderId++;
            encoders.put(id, encoder);
            call.resolve(new JSObject().put("contextId", id).put("embeddingSpace", BgeEmbeddingSession.SPACE));
        });
    }

    @PluginMethod public void tokenizeBge(PluginCall call) {
        submit(call, () -> {
            Encoder encoder = encoder(call);
            int[] tokens = encoder.session.tokenize(encoder.bundle, requiredString(call, "text"), encoder.limit);
            call.resolve(new JSObject().put("tokens", new JSONArray(tokens)));
        });
    }

    @PluginMethod public void embedBge(PluginCall call) {
        submit(call, () -> {
            Encoder encoder = encoder(call);
            call.resolve(JSObject.fromJSONObject(encoder.session.embed(encoder.bundle,
                requiredString(call, "text"), call.getArray("expectedTokenIds"),
                requiredString(call, "embeddingSpace"), encoder.limit)));
        });
    }

    @PluginMethod public void releaseBge(PluginCall call) {
        submit(call, () -> {
            Encoder encoder = encoder(call);
            encoder.session.close();
            encoders.remove(call.getInt("contextId"));
            call.resolve();
        });
    }

    @PluginMethod public void releaseAllContexts(PluginCall call) {
        submit(call, () -> {
            for (Encoder encoder : encoders.values()) encoder.session.close();
            encoders.clear();
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        if (encoderQueue.isShutdown()) return;
        encoderQueue.execute(() -> {
            for (Encoder encoder : encoders.values()) {
                try {
                    encoder.session.close();
                } catch (RuntimeException | LinkageError error) {
                    // error-policy:J6 Continue releasing independent contexts during app teardown.
                    Log.w("ElizaBgePlugin", "Cannot release BGE encoder", error);
                }
            }
            encoders.clear();
        });
        encoderQueue.shutdown();
        super.handleOnDestroy();
    }
}
