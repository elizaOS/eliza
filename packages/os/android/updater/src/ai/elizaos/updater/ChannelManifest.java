package ai.elizaos.updater;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The channel manifest packages/os/scripts/android/channel-manifest.mjs writes. Its detached Ed25519
 * signature is verified over the exact bytes before they are parsed. This class uses no Android API,
 * so the host tests run it as it ships.
 */
final class ChannelManifest {
    /** The largest channel response read. */
    static final int MAX_BYTES = 64 * 1024;
    /** update_engine also obeys POWERWASH, SPL_DOWNGRADE and more; only these reach it. */
    private static final String[] PROPERTIES = {"FILE_HASH=", "FILE_SIZE=", "METADATA_HASH=", "METADATA_SIZE="};

    final long sequence;
    final String version;
    private final JSONObject body;

    private ChannelManifest(JSONObject body) throws JSONException {
        this.body = body;
        sequence = body.getLong("sequence");
        version = body.getString("version");
    }

    /** The manifest when `signature` verifies and it is for this channel and device, at or above the highest accepted sequence. */
    static ChannelManifest verify(byte[] manifest, byte[] signature, String channelKey, String channel, String device, long highestSequence)
            throws GeneralSecurityException, JSONException {
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(channelKey))));
        verifier.update(manifest);
        if (!verifier.verify(signature)) throw new GeneralSecurityException("Channel manifest signature does not verify");
        JSONObject body = new JSONObject(new String(manifest, StandardCharsets.UTF_8));
        if (body.getInt("schema") != 1
                || !channel.equals(body.getString("channel"))
                || !device.equals(body.getString("device"))
                || body.getLong("sequence") < highestSequence
                || body.getInt("rolloutPercent") < 0
                || body.getInt("rolloutPercent") > 100)
            throw new GeneralSecurityException("Channel manifest is not for this image");
        return new ChannelManifest(body);
    }

    /** What the booted build streams: null when the rollout, the build date or the build identity rule it out. */
    Update offer(String fingerprint, long buildTimeMillis, String installId) throws GeneralSecurityException, JSONException {
        if (bucket(installId + version) >= body.getInt("rolloutPercent")
                || body.getLong("buildDateUtc") * 1000 <= buildTimeMillis
                || !identity(body.getString("buildFingerprint")).equals(identity(fingerprint)))
            return null;
        JSONArray updates = body.getJSONArray("updates");
        JSONObject full = null;
        for (int i = 0; i < updates.length(); i++) {
            JSONObject update = updates.getJSONObject(i);
            if (update.isNull("from")) full = update;
            else if (fingerprint.equals(update.getString("from"))) return new Update(update);
        }
        if (full == null) throw new GeneralSecurityException("Channel manifest has no full package");
        return new Update(full);
    }

    private static long bucket(String seed) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
        return Integer.toUnsignedLong(ByteBuffer.wrap(digest).getInt()) % 100;
    }

    /** Brand, product, device, type and tags: the fingerprint without its release, build id and incremental. */
    private static String identity(String fingerprint) {
        return fingerprint.replaceFirst(":[^/]*/[^/]*/[^:]*:", ":");
    }

    /** One package for UpdateEngine.applyPayload. */
    static final class Update {
        final String url;
        final long offset;
        final long size;
        private final String[] properties;

        private Update(JSONObject update) throws GeneralSecurityException, JSONException {
            url = update.getString("url");
            JSONObject payload = update.getJSONObject("payload");
            offset = payload.getLong("offset");
            size = payload.getLong("size");
            JSONArray listed = payload.getJSONArray("properties");
            if (!url.startsWith("https://") || offset < 0 || size <= 0 || listed.length() != PROPERTIES.length)
                throw new GeneralSecurityException("Channel package is not streamable");
            properties = new String[PROPERTIES.length];
            for (int i = 0; i < PROPERTIES.length; i++) {
                properties[i] = listed.getString(i);
                if (!properties[i].startsWith(PROPERTIES[i]) || properties[i].length() == PROPERTIES[i].length())
                    throw new GeneralSecurityException("Channel package is not streamable");
            }
            if (!properties[1].equals(PROPERTIES[1] + size)) throw new GeneralSecurityException("Channel package is not streamable");
        }

        /** The manifest's four properties and the network the job runs on, which keeps the transfer on it. */
        String[] headers(long networkHandle) {
            String[] headers = Arrays.copyOf(properties, properties.length + 1);
            headers[properties.length] = "NETWORK_ID=" + networkHandle;
            return headers;
        }
    }
}
