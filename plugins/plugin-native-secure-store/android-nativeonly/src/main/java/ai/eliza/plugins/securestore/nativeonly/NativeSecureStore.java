package ai.eliza.plugins.securestore.nativeonly;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;
import org.json.JSONTokener;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The production Capacitor store and its native-only consumers share custody and mutation fencing.
 * Uses the existing key alias, file names, Base64 envelope and logical-key AAD unchanged.
 * The fence covers writers in this Android process; this store must not have cross-process writers.
 */
public final class NativeSecureStore {
    public static final int MAXIMUM_VALUE_BYTES = 256 * 1024;
    private static final String KEY_ALIAS = "ai.elizaos.secure-store.v1";
    private static final Object LOCK = new Object();
    private static final String CLOCK_DEVICE_SLOT = "native.clock_device";
    private static long generation;
    private static final Set<String> ALLOWED_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "session.device_auth", "session.steward_token", "session.cloud_mobile_pending",
        "runtime.active_server", "runtime.agent_profiles")));
    private static final String[] SNAPSHOT_KEYS = {
        "runtime.active_server", "session.device_auth", "session.steward_token", "runtime.agent_profiles", CLOCK_DEVICE_SLOT
    };
    private final File directory;

    public NativeSecureStore(Context context) {
        directory = new File(Objects.requireNonNull(context).getNoBackupFilesDir(), "eliza-secure-store");
    }

    /** Native custody only: never serialize or return this object through a renderer bridge. */
    public static final class Snapshot {
        private final File directory;
        private final long generation;
        private final Map<String, String> values;
        private Snapshot(File directory, long generation, Map<String, String> values) {
            this.directory = directory;
            this.generation = generation;
            this.values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
        }
        public long getGeneration() { return generation; }
        /** Missing optional credentials remain explicit; corruption throws when the snapshot is read. */
        public String get(String key) {
            if (!values.containsKey(key)) throw new IllegalArgumentException("Unsupported snapshot key");
            return values.get(key);
        }
        public String require(String key) {
            String value = get(key);
            if (value == null || value.isEmpty()) throw new IllegalStateException("Native credential is missing");
            return value;
        }
        public DeviceIdentity requireClockDevice() throws Exception { return parseClockDevice(require(CLOCK_DEVICE_SLOT)); }
    }

    /** Native installation enrollment credential. It has no Capacitor get/set endpoint. */
    public static final class DeviceIdentity {
        private final String installationId, deviceKey;
        private DeviceIdentity(String installationId, String deviceKey) {
            this.installationId = installationId;
            this.deviceKey = deviceKey;
        }
        public String getInstallationId() { return installationId; }
        public String getDeviceKey() { return deviceKey; }
    }

    /** Initialize once in native custody; existing malformed values fail closed without rotation. */
    public DeviceIdentity ensureClockDevice() throws Exception {
        synchronized (LOCK) {
            String stored = readValue(CLOCK_DEVICE_SLOT);
            if (stored != null) return parseClockDevice(stored);
            byte[] entropy = new byte[32];
            new SecureRandom().nextBytes(entropy);
            char[] hex = new char[64];
            char[] digits = "0123456789abcdef".toCharArray();
            for (int i = 0; i < entropy.length; i++) {
                hex[i * 2] = digits[(entropy[i] & 255) >>> 4];
                hex[i * 2 + 1] = digits[entropy[i] & 15];
            }
            Arrays.fill(entropy, (byte) 0);
            String serialized = new JSONObject().put("version", 1)
                .put("installationId", UUID.randomUUID().toString()).put("deviceKey", new String(hex)).toString();
            Arrays.fill(hex, '\0');
            byte[] plaintext = serialized.getBytes(StandardCharsets.UTF_8);
            try {
                generation++;
                writeValue(CLOCK_DEVICE_SLOT, plaintext);
                String committed = readValue(CLOCK_DEVICE_SLOT);
                if (!serialized.equals(committed)) throw new IllegalStateException("Native device commit failed");
                return parseClockDevice(committed);
            } finally { Arrays.fill(plaintext, (byte) 0); }
        }
    }
    private static DeviceIdentity parseClockDevice(String value) throws Exception {
        JSONTokener parser = new JSONTokener(value);
        Object parsed = parser.nextValue();
        if (!(parsed instanceof JSONObject) || parser.nextClean() != 0)
            throw new IllegalStateException("Native device identity is malformed");
        JSONObject identity = (JSONObject) parsed;
        Object installation = identity.opt("installationId"), credential = identity.opt("deviceKey");
        if (identity.length() != 3 || !Integer.valueOf(1).equals(identity.opt("version"))
            || !(installation instanceof String) || !(credential instanceof String)
            || !((String) credential).matches("[a-f0-9]{64}")
            || !UUID.fromString((String) installation).toString().equals(installation))
            throw new IllegalStateException("Native device identity is malformed");
        return new DeviceIdentity((String) installation, (String) credential);
    }

    @FunctionalInterface
    public interface Effect<T> { T run() throws Exception; }

    public static boolean isAllowedKey(String key) { return ALLOWED_KEYS.contains(key); }
    private static void requireKey(String key) {
        if (key == null || !isAllowedKey(key)) throw new IllegalArgumentException("Secure-store key is not allowed");
    }
    public long getGeneration() { synchronized (LOCK) { return generation; } }
    public Snapshot snapshot() throws Exception {
        synchronized (LOCK) {
            Map<String, String> values = new LinkedHashMap<>();
            for (String key : SNAPSHOT_KEYS) values.put(key, readValue(key));
            return new Snapshot(directory.getCanonicalFile(), generation, values);
        }
    }
    public void assertCurrent(Snapshot snapshot) throws Exception {
        synchronized (LOCK) { requireCurrent(snapshot); }
    }
    /** Keep this callback synchronous and short: no network I/O while holding the credential lock. */
    public <T> T withSnapshot(Snapshot snapshot, Effect<T> effect) throws Exception {
        synchronized (LOCK) {
            requireCurrent(snapshot);
            return Objects.requireNonNull(effect).run();
        }
    }
    private void requireCurrent(Snapshot snapshot) throws Exception {
        if (snapshot == null || snapshot.generation != generation
            || !snapshot.directory.equals(directory.getCanonicalFile()))
            throw new SecurityException("Native credential owner changed");
    }
    public String get(String key) throws Exception {
        requireKey(key);
        synchronized (LOCK) { return readValue(key); }
    }
    public void set(String key, String value) throws Exception {
        requireKey(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Secure value is empty");
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
        try {
            if (plaintext.length > MAXIMUM_VALUE_BYTES) throw new IllegalArgumentException("Secure value is oversized");
            synchronized (LOCK) {
                generation++;
                writeValue(key, plaintext);
            }
        } finally { Arrays.fill(plaintext, (byte) 0); }
    }
    public boolean remove(String key) throws Exception {
        requireKey(key);
        synchronized (LOCK) {
            generation++;
            File file = valueFile(key);
            File[] artifacts = {file, new File(file.getPath() + ".bak"), new File(file.getPath() + ".new")};
            boolean existed = false;
            for (File artifact : artifacts) existed |= artifact.exists();
            new AtomicFile(file).delete();
            for (File artifact : artifacts)
                if (artifact.exists()) throw new IllegalStateException("Secure value deletion failed");
            return existed;
        }
    }
    public void ensureAvailable() throws Exception { synchronized (LOCK) { getOrCreateKey(); } }
    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    private void writeValue(String key, byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(plaintext), iv = cipher.getIV();
        byte[] payload = ByteBuffer.allocate(2 + iv.length + encrypted.length)
            .put((byte) 1).put((byte) iv.length).put(iv).put(encrypted).array();
        AtomicFile atomicFile = new AtomicFile(valueFile(key));
        java.io.FileOutputStream stream = atomicFile.startWrite();
        try {
            stream.write(Base64.encode(payload, Base64.NO_WRAP));
            atomicFile.finishWrite(stream);
        } catch (Exception error) {
            atomicFile.failWrite(stream);
            throw new IllegalStateException("Atomic secure value write failed", error);
        }
    }
    private String readValue(String key) throws Exception {
        File file = valueFile(key);
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) {
            if (CLOCK_DEVICE_SLOT.equals(key) && new File(file.getPath() + ".new").exists())
                throw new IllegalStateException("Native device identity commit is incomplete");
            return null;
        }
        byte[] encoded;
        try (InputStream stream = new AtomicFile(file).openRead()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                if (output.size() + read > MAXIMUM_VALUE_BYTES * 2) throw new IllegalStateException("Secure value is oversized");
                output.write(chunk, 0, read);
            }
            encoded = output.toByteArray();
        }
        ByteBuffer buffer = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP));
        if (buffer.remaining() < 2 || buffer.get() != 1) throw new IllegalStateException("Bad secure value format");
        int ivLength = buffer.get() & 255;
        if (ivLength != 12 || buffer.remaining() <= ivLength) throw new IllegalStateException("Bad secure value nonce");
        byte[] iv = new byte[ivLength]; buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()]; buffer.get(ciphertext);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        byte[] plaintext = cipher.doFinal(ciphertext);
        try {
            if (plaintext.length > MAXIMUM_VALUE_BYTES) throw new IllegalStateException("Secure value is oversized");
            return new String(plaintext, StandardCharsets.UTF_8);
        } finally { Arrays.fill(plaintext, (byte) 0); }
    }
    private File valueFile(String key) {
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory())
            throw new IllegalStateException("Secure store directory unavailable");
        return new File(directory, key.replace('.', '_') + ".enc");
    }
}
