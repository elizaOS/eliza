/** Owns the isolated, artifact-verified BGE encoder used by the delegated Android host. */
package ai.elizaos.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;

/** All calls are serialized by the owning server's resident lock and memory policy. */
final class BgeEmbeddingSession {
    static final String MODEL = "bge-small-en-v1.5-f16.gguf";
    static final String SHA256 = "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999";
    static final String SPACE = "BAAI/bge-small-en-v1.5:cls:l2:384";
    private long context;
    private String bundle;
    private int contextLimit;

    static final class Failure extends RuntimeException {
        final String code;
        Failure(String code, String message) { super(message); this.code = code; }
        Failure(String code, String message, Throwable cause) {
            super(message, cause); this.code = code;
        }
    }

    boolean isActive() { return context != 0L; }

    static byte[] completeUtf8(String text) {
        for (int i = 0; i < text.length(); i++) {
            char value = text.charAt(i);
            if (Character.isHighSurrogate(value)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) {
                    throw new Failure("EMBEDDING_INPUT_INVALID", "Unpaired UTF-16 surrogate");
                }
            } else if (Character.isLowSurrogate(value)) {
                throw new Failure("EMBEDDING_INPUT_INVALID", "Unpaired UTF-16 surrogate");
            }
        }
        return text.getBytes(StandardCharsets.UTF_8);
    }

    static int configuredContextLimit() {
        String value = System.getenv("ELIZA_EMBED_N_CTX");
        if (value == null || value.isEmpty()) return 512;
        if (!value.matches("[1-9][0-9]*")) {
            throw new Failure("EMBEDDING_CONTEXT_INVALID", "ELIZA_EMBED_N_CTX must be a positive native integer");
        }
        try {
            return Math.min(512, Integer.parseInt(value));
        } catch (NumberFormatException error) {
            // error-policy:J2 Preserve invalid native context configuration.
            throw new Failure("EMBEDDING_CONTEXT_INVALID", "ELIZA_EMBED_N_CTX exceeds the native integer range", error);
        }
    }

    static String verifyBundle(String requested) {
        if (requested.isEmpty() || requested.indexOf('\0') >= 0) {
            throw new Failure("EMBEDDING_ARTIFACT_INVALID", "An explicit BGE bundle path without NUL is required");
        }
        completeUtf8(requested);
        try {
            File root = new File(requested).getCanonicalFile();
            File text = new File(root, "text");
            File[] models = text.listFiles();
            if (models == null || models.length != 1 || !MODEL.equals(models[0].getName()) || !models[0].isFile()) {
                throw new Failure("EMBEDDING_ARTIFACT_INVALID", "Embedding bundle must contain only the pinned BGE GGUF");
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream input = new FileInputStream(models[0])) {
                byte[] block = new byte[65536];
                int count;
                while ((count = input.read(block)) != -1) digest.update(block, 0, count);
            }
            StringBuilder actual = new StringBuilder();
            for (byte b : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", b & 255));
            if (!SHA256.equals(actual.toString())) {
                throw new Failure("EMBEDDING_ARTIFACT_INVALID", "Install the pinned BGE-small artifact before embedding");
            }
            return root.getPath();
        } catch (IOException | NoSuchAlgorithmException error) {
            // error-policy:J2 Artifact read failures are unavailable, never chat-model fallback.
            throw new Failure("EMBEDDING_MODEL_UNAVAILABLE", "Cannot verify the BGE embedding bundle", error);
        }
    }

    JSONObject embed(String requestedBundle, String text) throws JSONException {
        byte[] input = completeUtf8(text);
        int limit = configuredContextLimit();
        if (context == 0L || !requestedBundle.equals(bundle)) {
            String verified = verifyBundle(requestedBundle);
            close();
            context = ElizaVoiceNative.nativeContextCreateUtf8(completeUtf8(verified));
            if (context == 0L) throw new Failure("EMBEDDING_BACKEND_UNAVAILABLE", "Cannot create BGE encoder context");
            bundle = requestedBundle;
            contextLimit = limit;
        } else if (limit != contextLimit) {
            throw new Failure("EMBEDDING_CONTEXT_INVALID", "Release the embedding model before changing ELIZA_EMBED_N_CTX");
        }
        int[] tokens = ElizaVoiceNative.nativeTokenizeUtf8(context, input);
        if (tokens == null || tokens.length == 0) {
            throw new Failure("EMBEDDING_BACKEND_UNAVAILABLE", "BGE tokenizer returned no tokens");
        }
        if (tokens.length > contextLimit) {
            throw new Failure("EMBEDDING_INPUT_TOO_LARGE", "Complete embedding input has " + tokens.length
                + " tokens; limit is " + contextLimit + ". Split the source into explicit lossless chunks.");
        }
        float[] vector = ElizaVoiceNative.nativeEmbedUtf8(context, input, 2);
        if (vector == null || vector.length != 384) {
            throw new Failure("EMBEDDING_VECTOR_INVALID", "BGE encoder must return 384 dimensions");
        }
        double normSquared = 0;
        for (float value : vector) {
            if (!Float.isFinite(value)) throw new Failure("EMBEDDING_VECTOR_INVALID", "BGE returned a non-finite component");
            normSquared += (double) value * value;
        }
        if (!(normSquared > 0) || !Double.isFinite(normSquared)) {
            throw new Failure("EMBEDDING_VECTOR_INVALID", "BGE returned an invalid vector norm");
        }
        double norm = Math.sqrt(normSquared);
        JSONArray values = new JSONArray();
        for (float value : vector) values.put(value / norm);
        return new JSONObject().put("ok", true).put("embedding", values).put("dim", vector.length)
            .put("tokens", tokens.length).put("embeddingSpace", SPACE);
    }

    void close() {
        if (context != 0L) ElizaVoiceNative.nativeContextDestroy(context);
        context = 0L;
        bundle = null;
    }
}
