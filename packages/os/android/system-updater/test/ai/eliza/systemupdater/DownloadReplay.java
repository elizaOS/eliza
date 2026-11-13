// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/** Real HTTPS/filesystem replay of the production downloader, not Android installation. */
public final class DownloadReplay {
    private static final byte[] BODY = new byte[4096];
    private static final List<String> observations = new ArrayList<>();
    private static final List<String> failures = new ArrayList<>();
    private static final AtomicInteger requests = new AtomicInteger(), ranges = new AtomicInteger();
    private static final String DIGEST;
    static {
        for (int i = 0; i < BODY.length; i++) BODY[i] = (byte) (i * 31 + 7);
        DIGEST = digest(BODY);
    }

    private static String digest(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception unavailable) { throw new AssertionError(unavailable); }
    }

    private static String quote(String text) {
        return text == null ? "null" : "\"" + text.replace("\\", "\\\\")
                .replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private static void observe(String name, String operation, Path directory, Boolean success, String error)
            throws IOException {
        Path partial = directory.resolve(DIGEST + ".partial"), zip = directory.resolve(DIGEST + ".zip");
        byte[] retained = Files.exists(partial) ? Files.readAllBytes(partial) : null;
        byte[] published = Files.exists(zip) ? Files.readAllBytes(zip) : null;
        observations.add("{\"case\":" + quote(name) + ",\"operation\":" + quote(operation)
                + ",\"partialExists\":" + (retained != null)
                + ",\"partialBytes\":" + (retained == null ? 0 : retained.length)
                + ",\"partialSha256\":" + quote(retained == null ? null : digest(retained))
                + ",\"zipBytes\":" + (published == null ? 0 : published.length)
                + ",\"zipSha256\":" + quote(published == null ? null : digest(published))
                + ",\"requests\":" + requests.get() + ",\"rangeRequests\":" + ranges.get()
                + ",\"success\":" + success + ",\"error\":" + quote(error) + "}");
    }

    private static boolean attempt(String name, String operation, Path directory, UpdateChannel channel)
            throws Exception {
        try {
            channel.download(new UpdateChannel.Candidate(new URL("https://updates.test/payload"),
                    DIGEST, "target", BODY.length, 1), directory.toFile());
            observe(name, operation, directory, true, null);
            return true;
        } catch (IOException refused) {
            observe(name, operation, directory, false, refused.getMessage());
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) failures.add(message);
    }

    private static void replay(Path root, String name, byte[] seed, boolean rejected, int firstRequests,
            int firstRanges, int expectedRequests, int expectedRanges) throws Exception {
        requests.set(0); ranges.set(0);
        Path directory = Files.createDirectory(root.resolve(name));
        observe(name, "initial", directory, null, null);
        Path partial = directory.resolve(DIGEST + ".partial");
        Files.write(partial, seed);
        observe(name, "seed", directory, null, null);
        UpdateChannel channel = new UpdateChannel("https://updates.test/manifest", new String[]{"updates.test"},
                "fixture", "fixture");
        if (rejected) {
            boolean first = attempt(name, "rejected", directory, channel);
            require(!first, name + " must refuse rejected bytes before publication");
            require(Files.size(partial) == 0, name + " must reset the owned rejected partial");
            require(requests.get() == firstRequests, name + " first real request count differs");
            require(ranges.get() == firstRanges, name + " first Range request count differs");
        }
        boolean accepted = attempt(name, rejected ? "retry" : "published", directory, channel);
        Path zip = directory.resolve(DIGEST + ".zip");
        require(accepted && Files.isRegularFile(zip) && Arrays.equals(Files.readAllBytes(zip), BODY),
                name + " must publish exact bytes on the later valid response");
        require(!Files.exists(partial), name + " published bytes must leave no partial");
        require(requests.get() == expectedRequests, name + " real request count differs");
        require(ranges.get() == expectedRanges, name + " real Range request count differs");
    }

    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]), keyStore = Path.of(args[1]), output = Path.of(args[2]);
        Files.createDirectories(directory);
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (InputStream input = Files.newInputStream(keyStore)) { keys.load(input, "fixture-pass".toCharArray()); }
        KeyManagerFactory keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keyManagers.init(keys, "fixture-pass".toCharArray());
        TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(keys);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(keyManagers.getKeyManagers(), trust.getTrustManagers(), null);
        HttpsURLConnection.setDefaultSSLSocketFactory(tls.getSocketFactory());
        HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(tls));
        server.createContext("/payload", exchange -> {
            requests.incrementAndGet();
            String range = exchange.getRequestHeaders().getFirst("Range");
            int offset = 0, status = 200;
            if (range != null) {
                ranges.incrementAndGet();
                if (!range.matches("bytes=[0-9]+-")) throw new IOException("Unexpected fixture Range");
                offset = Integer.parseInt(range.substring(6, range.length() - 1)); status = 206;
                exchange.getResponseHeaders().set("Content-Range", "bytes " + offset + "-"
                        + (BODY.length - 1) + "/" + BODY.length);
            }
            exchange.sendResponseHeaders(status, BODY.length - offset);
            try (var body = exchange.getResponseBody()) { body.write(BODY, offset, BODY.length - offset); }
            finally { exchange.close(); }
        });
        // Retain the real JDK handler before installing this process-local test route.
        // Production still admits only default-port HTTPS URLs and performs ordinary TLS checks.
        URL transport = new URL("https://127.0.0.1:" + server.getAddress().getPort() + "/payload");
        URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL ignored) throws IOException {
                return transport.openConnection();
            }
        });
        server.start();
        try {
            byte[] corrupt = BODY.clone(); corrupt[0] ^= 1;
            replay(directory, "corrupt-full", corrupt, true, 0, 0, 1, 0);
            replay(directory, "oversized", Arrays.copyOf(BODY, BODY.length + 7), true, 0, 0, 1, 0);
            byte[] badPrefix = Arrays.copyOf(BODY, BODY.length / 2); badPrefix[0] ^= 1;
            replay(directory, "bad-prefix", badPrefix, true, 1, 1, 2, 1);
            replay(directory, "valid-prefix", Arrays.copyOf(BODY, BODY.length / 2), false, 0, 0, 1, 1);
            replay(directory, "verified-full", BODY.clone(), false, 0, 0, 0, 0);
        } finally {
            server.stop(0);
            String json = "{\"schema\":\"eliza-system-update-download-trace/v1\",\"expectedBytes\":" + BODY.length
                    + ",\"expectedSha256\":" + quote(DIGEST) + ",\"prefixBytes\":" + BODY.length / 2
                    + ",\"prefixSha256\":" + quote(digest(Arrays.copyOf(BODY, BODY.length / 2)))
                    + ",\"observations\":[" + String.join(",", observations) + "]}\n";
            Files.writeString(output, json);
            System.out.print(json);
        }
        if (!failures.isEmpty()) throw new AssertionError(String.join("; ", failures));
        System.out.println("PASS 5 production download cases over owned HTTPS");
    }
}
