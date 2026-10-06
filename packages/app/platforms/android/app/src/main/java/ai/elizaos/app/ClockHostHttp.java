package ai.elizaos.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Bounded HTTP transport shared by buffered JSON and incremental chat. Never follows redirects or retries. */
final class ClockHostHttp {
    interface Fence { void current() throws Exception; }
    interface Stream {
        void connected(HttpURLConnection connection);
        void head(Response response) throws Exception;
        void chunk(String data) throws Exception;
        void done() throws Exception;
        boolean cancelled();
    }
    static final class Response {
        final int status;
        final String data, contentType;
        Response(int status, String data, String contentType) { this.status = status; this.data = data; this.contentType = contentType; }
    }
    static Response request(URI uri, String method, String body, Map<String, String> headers, Fence fence, Stream stream) throws Exception {
        return request(uri, method, body, headers, fence, stream, ignored -> {});
    }
    static Response request(URI uri, String method, String body, Map<String, String> headers, Fence fence, Stream stream,
                            java.util.function.Consumer<HttpURLConnection> connected) throws Exception {
        fence.current();
        byte[] bytes = body == null ? null : body.getBytes(StandardCharsets.UTF_8);
        if (bytes != null && bytes.length > 256 * 1024) throw new IllegalArgumentException("Native request exceeds byte budget");
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(20000);
        connected.accept(connection);
        if (stream != null) stream.connected(connection);
        try {
            connection.setRequestMethod(method);
            for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            if (bytes != null) {
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length); fence.current();
                if (stream != null && stream.cancelled()) throw new java.io.InterruptedIOException("Native request cancelled");
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new SecurityException("Native agent redirects are not permitted");
            fence.current();
            String type = connection.getHeaderField("Content-Type");
            if (type == null || !type.matches("(?i)(?:application/json|text/event-stream|text/plain)(?:;[ -~]{0,100})?")) type = "application/octet-stream";
            Response head = new Response(status, "", type);
            if (stream != null) stream.head(head);
            InputStream raw = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            long deadline = System.nanoTime() + (stream == null ? 30_000_000_000L : 300_000_000_000L);
            ByteArrayOutputStream buffered = new ByteArrayOutputStream();
            if (raw != null) try (InputStream input = new java.io.FilterInputStream(raw) {
                int total;
                @Override public int read(byte[] data, int offset, int length) throws java.io.IOException {
                    int read = super.read(data, offset, length);
                    if (read > 0) total += read;
                    if (total > 2 * 1024 * 1024 || System.nanoTime() > deadline || (stream != null && stream.cancelled()))
                        throw new java.io.InterruptedIOException("Native response exceeds byte/time budget or was cancelled");
                    return read;
                }
            }) {
                if (stream == null) {
                    byte[] chunk = new byte[8192]; int read;
                    while ((read = input.read(chunk)) != -1) { fence.current(); buffered.write(chunk, 0, read); }
                } else {
                    InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8.newDecoder()
                            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT));
                    char[] chunk = new char[8192]; int read; String carry = "";
                    while ((read = reader.read(chunk)) != -1) {
                        fence.current();
                        String data = carry + new String(chunk, 0, read); carry = "";
                        if (!data.isEmpty() && Character.isHighSurrogate(data.charAt(data.length() - 1))) {
                            carry = data.substring(data.length() - 1); data = data.substring(0, data.length() - 1);
                        }
                        if (!data.isEmpty()) stream.chunk(data);
                    }
                    if (!carry.isEmpty()) throw new java.io.IOException("Incomplete native Unicode response");
                }
            }
            fence.current();
            if (stream != null) stream.done();
            return new Response(status, new String(buffered.toByteArray(), StandardCharsets.UTF_8), type);
        } finally { connection.disconnect(); }
    }
}
