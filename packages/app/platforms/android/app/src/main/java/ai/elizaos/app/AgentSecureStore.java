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
    /** Installed Keystore alias and no-backup directory; {@link ElizaDataResetStores} lists both. */
    static final String KEY_ALIAS = "ai.elizaos.app.remote-target.v1";
    static final String DIRECTORY_NAME = "remote-target-secrets";
    private static final int MAX_FRAME = 4 * 1024 * 1024;
    private final File directory;
    private final LocalServerSocket server;
    private volatile boolean closed;
    private volatile LocalSocket active;

    AgentSecureStore(Context context) throws IOException {
        directory = new File(context.getNoBackupFilesDir(), DIRECTORY_NAME);
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
                int peerUid = socket.getPeerCredentials().getUid();
                if (peerUid != Process.myUid()) continue;
                socket.setSoTimeout(15000);
                InputStream input = socket.getInputStream();
                while (!closed) {
                    byte[] header = SecureStoreFrameInput.readBounded(input, 4);
                    if (header.length == 0) break;
                    if (header.length != 4) throw new IOException("Incomplete secure-store frame");
                    long size = 0;
                    for (int i = 0; i < 4; i++) size |= ((long) header[i] & 255) << (i * 8);
                    if (size < 1 || size > MAX_FRAME) throw new IOException("Secure-store frame exceeds limit");
                    byte[] bytes = SecureStoreFrameInput.readBounded(input, (int) size);
                    if (bytes.length != size) throw new IOException("Incomplete secure-store request");
                    JSONObject request = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                    JSONObject response;
                    try {
                        response = execute(request, peerUid);
                    } catch (NativeSourceHost.OwnerReminderContextUnavailable unavailable) {
                        response = new JSONObject().put("ok", false).put("reason", "unavailable");
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

    private static final String VAULT_PASSPHRASE_FILE = "vault-passphrase";
    private static final byte[] VAULT_PASSPHRASE_AAD = "eliza-vault-passphrase".getBytes(StandardCharsets.UTF_8);

    /** The agent vault's stored random passphrase, or null when none was created. */
    static synchronized String readVaultPassphrase(Context context) throws Exception {
        AtomicFile file = vaultPassphraseFile(context);
        if (!file.getBaseFile().exists()) return null;
        byte[] envelope = file.readFully();
        if (envelope.length < 29 || envelope.length > 4096) throw new IOException("Invalid encrypted record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(envelope, 0, 12)));
        cipher.updateAAD(VAULT_PASSPHRASE_AAD);
        return new String(cipher.doFinal(envelope, 12, envelope.length - 12), StandardCharsets.UTF_8);
    }

    /** Generate 32 random bytes once, store them Keystore-wrapped, and return them hex-encoded. */
    static synchronized String createVaultPassphrase(Context context) throws Exception {
        String existing = readVaultPassphrase(context);
        if (existing != null) return existing;
        byte[] secret = new byte[32];
        new java.security.SecureRandom().nextBytes(secret);
        StringBuilder hex = new StringBuilder(secret.length * 2);
        for (byte value : secret) hex.append(String.format("%02x", value & 255));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(VAULT_PASSPHRASE_AAD);
        byte[] ciphertext = cipher.doFinal(hex.toString().getBytes(StandardCharsets.UTF_8));
        AtomicFile file = vaultPassphraseFile(context);
        FileOutputStream output = file.startWrite();
        try {
            output.write(cipher.getIV());
            output.write(ciphertext);
            file.finishWrite(output);
        } catch (IOException error) {
            file.failWrite(output);
            throw error;
        }
        return hex.toString();
    }

    /** True when a random passphrase was stored, even if it cannot be read right now. */
    static boolean hasVaultPassphrase(Context context) {
        File directory = new File(context.getNoBackupFilesDir(), DIRECTORY_NAME);
        return new AtomicFile(new File(directory, VAULT_PASSPHRASE_FILE)).getBaseFile().exists();
    }

    private static AtomicFile vaultPassphraseFile(Context context) throws IOException {
        File directory = new File(context.getNoBackupFilesDir(), DIRECTORY_NAME);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create secure storage");
        return new AtomicFile(new File(directory, VAULT_PASSPHRASE_FILE));
    }

    // Class-locked: the instance store and the static vault passphrase share this
    // alias, and two first-use generators racing would replace the key the
    // other one already encrypted with.
    private static synchronized SecretKey key() throws Exception {
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

    private JSONObject execute(JSONObject request, int peerUid) throws Exception {
        if (peerUid != Process.myUid()) throw new SecurityException("Unauthorized secure-store peer");
        if ("nativeOwnerContext".equals(request.optString("operation"))) {
            String id = request.optString("id");
            if (request.length() != 2 || id.isEmpty() || id.length() > 128) throw new SecurityException("Invalid native owner request");
            return new JSONObject().put("ok", true).put("context", NativeSourceHost.readOwnerReminderContext(peerUid, Process.myUid()));
        }
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
        // close() alone leaves accept() blocked and the abstract address bound.
        try { android.system.Os.shutdown(server.getFileDescriptor(), android.system.OsConstants.SHUT_RDWR); }
        catch (android.system.ErrnoException ignored) { /* Already closed; close() below still runs. */ }
        try { server.close(); } catch (IOException error) {
            Log.w("ElizaSecureStore", "Could not close secure-store listener");
        }
    }
}
