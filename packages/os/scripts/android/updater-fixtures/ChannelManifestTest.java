package ai.elizaos.updater;

import ai.elizaos.updater.ChannelManifest.Update;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;

/** The real ChannelManifest with real Ed25519: normal-positive rows, then bug-negative rows. */
public final class ChannelManifestTest {
    private static final String BOOTED = "Alpha/alpha_stallion_phone/stallion:17/CP2A.260605.016/20261102.1:userdebug/test-keys";
    private static final String NEXT = "Alpha/alpha_stallion_phone/stallion:17/CP2A.260605.016/20261103.1:userdebug/test-keys";
    private static final long BUILT = 1_793_000_000L;
    private static final String PROPERTIES = "\"FILE_HASH=aGFzaA==\",\"FILE_SIZE=1000\",\"METADATA_HASH=bWV0YQ==\",\"METADATA_SIZE=12\"";
    private static final KeyPair KEYS = keys();
    private static final String KEY = key(KEYS);
    private static int checks;

    private interface Refused { void run() throws Exception; }

    private static KeyPair keys() {
        try {
            return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static String key(KeyPair pair) {
        return Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
    }

    private static byte[] sign(byte[] bytes, KeyPair pair) throws Exception {
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(pair.getPrivate());
        signer.update(bytes);
        return signer.sign();
    }

    /** One manifest as channel-manifest.mjs lays it out; each row changes what it tests. */
    private static final class Row {
        int schema = 1;
        String channel = "beta";
        String device = "stallion";
        String version = "1.0.0";
        long sequence = 5;
        String fingerprint = NEXT;
        long date = BUILT + 1;
        int rollout = 100;
        String fullUrl = "https://updates.example/ota.zip";
        String properties = PROPERTIES;
        String incremental = "";

        byte[] bytes() {
            return ("{\n  \"schema\": " + schema + ",\n  \"channel\": \"" + channel + "\",\n  \"device\": \"" + device
                + "\",\n  \"version\": \"" + version + "\",\n  \"sequence\": " + sequence
                + ",\n  \"buildFingerprint\": \"" + fingerprint + "\",\n  \"buildDateUtc\": " + date
                + ",\n  \"securityPatch\": null,\n  \"rolloutPercent\": " + rollout + ",\n  \"updates\": ["
                + "{\"from\": null, \"url\": \"" + fullUrl + "\", \"sha256\": \"aa\", \"sizeBytes\": 2000,"
                + " \"payload\": {\"offset\": 41, \"size\": 1000, \"properties\": [" + properties + "]}}"
                + incremental + "]\n}\n").getBytes(StandardCharsets.UTF_8);
        }

        Update offer() throws Exception {
            return offerFor("install-1");
        }

        Update offerFor(String installId) throws Exception {
            byte[] bytes = bytes();
            return ChannelManifest.verify(bytes, sign(bytes, KEYS), KEY, "beta", "stallion", 5).offer(BOOTED, BUILT * 1000, installId);
        }
    }

    private static Row row() {
        return new Row();
    }

    private static String incremental(String from) {
        return ",{\"from\": \"" + from + "\", \"url\": \"https://updates.example/delta.zip\", \"sha256\": \"bb\", \"sizeBytes\": 200,"
            + " \"payload\": {\"offset\": 99, \"size\": 100, \"properties\": [" + PROPERTIES + "]}}";
    }

    private static void check(boolean value) {
        if (!value) throw new AssertionError("Check " + checks);
        checks++;
    }

    private static void refused(Refused action) throws Exception {
        try {
            action.run();
        } catch (java.security.GeneralSecurityException | org.json.JSONException expected) {
            checks++;
            return;
        }
        throw new AssertionError("Accepted after check " + checks);
    }

    private static void normalPositive() throws Exception {
        Update full = row().offer();
        check(full.url.equals("https://updates.example/ota.zip") && full.offset == 41 && full.size == 1000);
        check(Arrays.equals(full.headers(77), new String[] {"FILE_HASH=aGFzaA==", "FILE_SIZE=1000", "METADATA_HASH=bWV0YQ==", "METADATA_SIZE=12", "NETWORK_ID=77"}));

        Row delta = row();
        delta.incremental = incremental(BOOTED);
        Update chosen = delta.offer();
        check(chosen.url.equals("https://updates.example/delta.zip") && chosen.offset == 99 && chosen.size == 100);

        Row other = row();
        other.incremental = incremental(NEXT.replace("20261103.1", "20261101.1"));
        check(other.offer().url.equals("https://updates.example/ota.zip"));

        for (int i = 0; i < 50; i++) check(row().offerFor("install-" + i) != null);

        Row half = row();
        half.rollout = 50;
        int taken = 0;
        for (int i = 0; i < 400; i++) if (half.offerFor("install-" + i) != null) taken++;
        check(taken > 120 && taken < 280);
        check((half.offerFor("install-1") != null) == (half.offerFor("install-1") != null));

        Row higher = row();
        higher.sequence = 9;
        byte[] bytes = higher.bytes();
        check(ChannelManifest.verify(bytes, sign(bytes, KEYS), KEY, "beta", "stallion", 5).sequence == 9);
        check(row().bytes().length < ChannelManifest.MAX_BYTES);
    }

    private static void bugNegative() throws Exception {
        byte[] signed = row().bytes();
        byte[] signature = sign(signed, KEYS);
        byte[] tampered = signed.clone();
        tampered[tampered.length / 2] ^= 1;
        refused(() -> ChannelManifest.verify(tampered, signature, KEY, "beta", "stallion", 0));
        byte[] flipped = signature.clone();
        flipped[0] ^= 1;
        refused(() -> ChannelManifest.verify(signed, flipped, KEY, "beta", "stallion", 0));
        refused(() -> ChannelManifest.verify(signed, sign(signed, keys()), KEY, "beta", "stallion", 0));
        refused(() -> ChannelManifest.verify(signed, new byte[0], KEY, "beta", "stallion", 0));
        byte[] notJson = "not json".getBytes(StandardCharsets.UTF_8);
        refused(() -> ChannelManifest.verify(notJson, sign(notJson, KEYS), KEY, "beta", "stallion", 0));

        refused(() -> ChannelManifest.verify(signed, signature, KEY, "stable", "stallion", 0));
        refused(() -> ChannelManifest.verify(signed, signature, KEY, "beta", "grizzly", 0));
        refused(() -> ChannelManifest.verify(signed, signature, KEY, "beta", "stallion", 6));
        Row schema = row();
        schema.schema = 2;
        refused(schema::offer);

        Row halted = row();
        halted.rollout = 0;
        for (int i = 0; i < 50; i++) check(halted.offerFor("install-" + i) == null);

        Row same = row();
        same.date = BUILT;
        check(same.offer() == null);
        Row older = row();
        older.date = BUILT - 1;
        check(older.offer() == null);

        for (String other : new String[] {
                NEXT.replace("test-keys", "release-keys"), NEXT.replace("test-keys", "dev-keys"), NEXT.replace(":userdebug/", ":user/"),
                NEXT.replace("Alpha/", "Other/"), NEXT.replace("alpha_stallion_phone", "eliza_stallion_phone"), NEXT.replace("/stallion:", "/grizzly:")}) {
            Row foreign = row();
            foreign.fingerprint = other;
            check(foreign.offer() == null);
        }

        Row cleartext = row();
        cleartext.fullUrl = "http://updates.example/ota.zip";
        refused(cleartext::offer);
        Row wipes = row();
        wipes.properties = PROPERTIES + ",\"POWERWASH=1\"";
        refused(wipes::offer);
        Row swapped = row();
        swapped.properties = PROPERTIES.replace("METADATA_SIZE=12", "POWERWASH=1");
        refused(swapped::offer);
        Row missing = row();
        missing.properties = "\"FILE_HASH=aGFzaA==\"";
        refused(missing::offer);
    }

    /** Prints what `verify` and `offer` decide for files written by channel-manifest.mjs. */
    private static void roundTrip(String[] args) throws Exception {
        ChannelManifest manifest = ChannelManifest.verify(Files.readAllBytes(Path.of(args[0])), Files.readAllBytes(Path.of(args[1])), args[2], args[3], args[4], 0);
        Update update = manifest.offer(args[5], Long.parseLong(args[6]), args[7]);
        System.out.println(update == null ? "none" : String.join("|", update.url, String.valueOf(update.offset), String.valueOf(update.size), String.join("&", update.headers(7))));
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            roundTrip(args);
            return;
        }
        normalPositive();
        bugNegative();
        System.out.println("PASS " + checks + " checks");
    }
}
