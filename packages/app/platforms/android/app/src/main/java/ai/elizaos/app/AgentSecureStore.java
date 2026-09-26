package ai.elizaos.app;

import android.content.Context;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Process;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Same-UID agent bridge. Only ciphertext is persisted; keys never leave Android Keystore. */
final class AgentSecureStore implements AutoCloseable {
    private static final String KEY_ALIAS = "ai.elizaos.app.remote-target.v1";
    private static final int MAX_FRAME = 4 * 1024 * 1024;
    private final File directory;
    private final LocalServerSocket server;
    private volatile boolean closed;
    private volatile LocalSocket active;

    AgentSecureStore(Context context) throws IOException {
        directory = new File(context.getNoBackupFilesDir(), "remote-target-secrets");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create secure storage");
        server = new LocalServerSocket("ai.elizaos.app.secure-store");
        Thread worker = new Thread(this::serve, "ElizaSecureStore");
        worker.setDaemon(true);
        worker.start();
    }

    private void serve() {
        while (!closed) {
            try (LocalSocket socket = server.accept()) {
                active = socket;
                if (socket.getPeerCredentials().getUid() != Process.myUid()) continue;
                socket.setSoTimeout(15000);
                InputStream input = socket.getInputStream();
                while (!closed) {
                    byte[] header = input.readNBytes(4);
                    if (header.length == 0) break;
                    if (header.length != 4) throw new IOException("Incomplete secure-store frame");
                    long size = 0;
                    for (int i = 0; i < 4; i++) size |= ((long) header[i] & 255) << (i * 8);
                    if (size < 1 || size > MAX_FRAME) throw new IOException("Secure-store frame exceeds limit");
                    byte[] bytes = input.readNBytes((int) size);
                    if (bytes.length != size) throw new IOException("Incomplete secure-store request");
                    JSONObject request = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                    JSONObject response;
                    try {
                        response = execute(request);
                    } catch (SecurityException error) {
                        response = new JSONObject().put("ok", false).put("reason", "denied");
                    } catch (Exception error) {
                        // error-policy:J1 Fail closed, without including secret request data in diagnostics.
                        Log.e("ElizaSecureStore", "Secure-store operation failed: " + error.getClass().getSimpleName());
                        response = new JSONObject().put("ok", false).put("reason", "error");
                    }
                    response.put("id", request.optString("id"));
                    byte[] encoded = response.toString().getBytes(StandardCharsets.UTF_8);
                    if (encoded.length > MAX_FRAME) throw new IOException("Secure-store response exceeds limit");
                    byte[] prefix = new byte[4];
                    for (int i = 0; i < 4; i++) prefix[i] = (byte) (encoded.length >>> (8 * i));
                    socket.getOutputStream().write(prefix);
                    socket.getOutputStream().write(encoded);
                    socket.getOutputStream().flush();
                }
            } catch (Exception error) {
                // error-policy:J1 Malformed/unauthorized/disconnected clients are isolated from later requests.
                if (!closed) Log.w("ElizaSecureStore", "Secure-store connection ended: " + error.getClass().getSimpleName());
            } finally {
                active = null;
            }
        }
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    private JSONObject execute(JSONObject request) throws Exception {
        String vault = request.getString("vaultId");
        String kind = request.getString("secretKind");
        String operation = request.getString("operation");
        if (vault.isEmpty() || vault.length() > 256 || !"runtime.agent_profiles".equals(kind)
            || request.optString("id").isEmpty() || request.optString("id").length() > 128) {
            throw new SecurityException("Unauthorized secure-store slot");
        }
        byte[] aad = (vault + "\0" + kind).getBytes(StandardCharsets.UTF_8);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(aad);
        StringBuilder name = new StringBuilder();
        for (byte value : digest) name.append(String.format("%02x", value & 255));
        AtomicFile file = new AtomicFile(new File(directory, name.toString()));
        if ("delete".equals(operation)) {
            boolean exists = file.getBaseFile().exists();
            file.delete();
            if (file.getBaseFile().exists()) throw new IOException("Secure-store deletion failed");
            return new JSONObject().put("ok", true).put("deleted", exists);
        }
        if ("get".equals(operation)) {
            if (!file.getBaseFile().exists()) return new JSONObject().put("ok", false).put("reason", "not_found");
            byte[] envelope = file.readFully();
            if (envelope.length < 29 || envelope.length > MAX_FRAME) throw new IOException("Invalid encrypted record");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(envelope, 0, 12)));
            cipher.updateAAD(aad);
            byte[] plaintext = cipher.doFinal(envelope, 12, envelope.length - 12);
            return new JSONObject().put("ok", true).put("value", new String(plaintext, StandardCharsets.UTF_8));
        }
        if ("set".equals(operation)) {
            byte[] plaintext = request.getString("value").getBytes(StandardCharsets.UTF_8);
            // Reserve JSON escaping/metadata room so every stored value is readable through this transport.
            if (plaintext.length > (MAX_FRAME - 1024) / 6) throw new IOException("Secure-store value exceeds limit");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(aad);
            byte[] ciphertext = cipher.doFinal(plaintext);
            FileOutputStream output = file.startWrite();
            try {
                output.write(cipher.getIV());
                output.write(ciphertext);
                file.finishWrite(output);
            } catch (IOException error) {
                file.failWrite(output);
                throw error;
            }
            return new JSONObject().put("ok", true);
        }
        throw new SecurityException("Unauthorized secure-store operation");
    }

    @Override public void close() {
        closed = true;
        try { if (active != null) active.close(); } catch (IOException error) {
            Log.w("ElizaSecureStore", "Could not close secure-store client");
        }
        try { server.close(); } catch (IOException error) {
            Log.w("ElizaSecureStore", "Could not close secure-store listener");
        }
    }
}
