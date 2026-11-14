// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.os.Build;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONException;
import org.json.JSONObject;

/** Public release discovery only. OTA signature verification remains a separate gate. */
final class UpdateChannel {
    static final class Candidate {
        final URL url;
        final String sha256, fingerprint;
        final long bytes, timestamp;
        Candidate(URL url, String sha256, String fingerprint, long bytes, long timestamp) {
            this.url = url; this.sha256 = sha256; this.fingerprint = fingerprint;
            this.bytes = bytes; this.timestamp = timestamp;
        }
    }

    private final Set<String> hosts;
    private final String product, device;
    private final URL manifest;

    UpdateChannel(String manifestUrl, String[] hosts, String product, String device) throws IOException {
        this.hosts = new HashSet<>(Arrays.asList(hosts));
        this.product = product; this.device = device;
        manifest = allowed(new URL(manifestUrl));
        if (product.isEmpty() || device.isEmpty() || this.hosts.isEmpty()) {
            throw new IOException("OS update channel is not enrolled");
        }
    }

    Candidate discover() throws IOException {
        HttpsURLConnection connection = connect(manifest);
        try (InputStream input = connection.getInputStream()) {
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (data.size() + count > 65536) throw new IOException("Update manifest exceeds bound");
                data.write(buffer, 0, count);
            }
            JSONObject value = new JSONObject(data.toString(StandardCharsets.UTF_8));
            if (value.getInt("schema") != 1 || !product.equals(value.getString("product"))
                    || !device.equals(value.getString("device"))) {
                throw new IOException("Update manifest belongs to another product");
            }
            String sha256 = value.getString("sha256"), fingerprint = value.getString("buildFingerprint");
            long size = number(value, "sizeBytes"), timestamp = number(value, "buildTimestamp");
            if (!sha256.matches("[0-9a-f]{64}") || fingerprint.length() > 4096
                    || size > 12L * 1024 * 1024 * 1024) throw new IOException("Invalid update manifest");
            if (timestamp <= Build.TIME / 1000 || fingerprint.equals(Build.FINGERPRINT)) return null;
            return new Candidate(allowed(new URL(value.getString("url"))), sha256, fingerprint, size, timestamp);
        } catch (JSONException | IllegalArgumentException malformed) {
            throw new IOException("Invalid update manifest", malformed);
        } finally { connection.disconnect(); }
    }

    static final class DownloadDeferred extends IOException {
        DownloadDeferred() { super("Update download is paused with retained progress"); }
    }

    File download(Candidate candidate, File directory) throws IOException {
        if (!directory.isDirectory() || !directory.getCanonicalFile().equals(directory.getAbsoluteFile())) {
            throw new IOException("Update storage is unavailable");
        }
        File destination = new File(directory, candidate.sha256 + ".zip");
        if (destination.exists()) throw new IOException("Retained package requires verification before reuse");
        File partial = new File(directory, candidate.sha256 + ".partial");
        if (partial.exists() && (!partial.isFile()
                || !partial.getCanonicalFile().equals(partial.getAbsoluteFile()))) {
            throw new IOException("Invalid retained download");
        }
        long started = SystemClock.elapsedRealtime();
        HttpsURLConnection connection = null;
        try (RandomAccessFile output = new RandomAccessFile(partial, "rw");
                FileLock held = output.getChannel().tryLock()) {
            if (held == null) throw new IOException("Another download owns this file");
            long received = output.length();
            if (received > candidate.bytes) throw new IOException("Retained download exceeds expected length");
            if (directory.getUsableSpace() < candidate.bytes - received + candidate.bytes + 2L * 1024 * 1024 * 1024) {
                throw new IOException("Insufficient space for a preserving OS update");
            }
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[1024 * 1024]; int count;
            output.seek(0);
            while ((count = output.read(buffer)) != -1) {
                checkDownloadWindow(started); hash.update(buffer, 0, count);
            }
            if (received < candidate.bytes) {
                connection = connect(candidate.url, received);
                int status = connection.getResponseCode();
                if (received > 0 && status == 200) {
                    // A server that ignores Range restarts this known-unapplied local download.
                    output.setLength(0); output.seek(0); received = 0; hash.reset();
                } else if (status == 206) {
                    String expected = "bytes " + received + "-" + (candidate.bytes - 1) + "/" + candidate.bytes;
                    if (!expected.equals(connection.getHeaderField("Content-Range"))) {
                        throw new IOException("Update range differs from the retained package");
                    }
                }
                long declared = connection.getContentLengthLong();
                if (declared >= 0 && declared != candidate.bytes - received) {
                    throw new IOException("Update length differs");
                }
                output.seek(received);
                long synced = received;
                try (InputStream input = connection.getInputStream()) {
                    while ((count = input.read(buffer)) != -1) {
                        checkDownloadWindow(started);
                        received += count;
                        if (received > candidate.bytes) throw new IOException("Update exceeds declared length");
                        output.write(buffer, 0, count); hash.update(buffer, 0, count);
                        if (received - synced >= 4 * 1024 * 1024) { output.getFD().sync(); synced = received; }
                    }
                } finally { output.getFD().sync(); }
            }
            if (received != candidate.bytes) throw new DownloadDeferred();
            if (!hex(hash.digest()).equals(candidate.sha256)) {
                throw new IOException("Complete update package digest differs");
            }
        } catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
        finally { if (connection != null) connection.disconnect(); }
        Files.move(partial.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
        return destination;
    }

    private static void checkDownloadWindow(long started) throws DownloadDeferred {
        if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() - started > 8 * 60_000L) {
            throw new DownloadDeferred();
        }
    }

    private HttpsURLConnection connect(URL initial) throws IOException { return connect(initial, -1); }

    private HttpsURLConnection connect(URL initial, long offset) throws IOException {
        URL url = initial;
        for (int redirects = 0; redirects <= 3; redirects++) {
            HttpsURLConnection connection = (HttpsURLConnection) allowed(url).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20000);
            connection.setReadTimeout(20000); connection.setRequestProperty("Accept-Encoding", "identity");
            if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
            int status = connection.getResponseCode();
            if (status == 200 || (offset > 0 && status == 206)) return connection;
            String location = connection.getHeaderField("Location"); connection.disconnect();
            if (status < 300 || status >= 400 || location == null || redirects == 3) {
                throw new IOException("Update service refused the request");
            }
            url = allowed(new URL(url, location));
        }
        throw new IOException("Update redirect limit");
    }

    private URL allowed(URL url) throws IOException {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null
                || url.getRef() != null || (url.getPort() != -1 && url.getPort() != 443)
                || !hosts.contains(url.getHost().toLowerCase(Locale.ROOT))) {
            throw new IOException("Update URL is outside the enrolled channel");
        }
        return url;
    }

    private static long number(JSONObject value, String key) throws JSONException, IOException {
        String text = value.get(key).toString();
        if (!text.matches("[1-9][0-9]{0,18}")) throw new IOException("Invalid update number");
        try { return Long.parseLong(text); }
        catch (NumberFormatException invalid) { throw new IOException("Update number overflow"); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(64);
        for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 255));
        return value.toString();
    }
}
