package ai.elizaos.app;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Production policy and HTTP transport against synthetic loopback HTTP only; no Android credentials or UI. */
public final class ClockHostPolicyTest {
    private static int checks;
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); } catch (Exception expected) { checks++; return; }
        throw new AssertionError("Untrusted native host transition admitted");
    }
    public static void main(String[] args) throws Exception {
        for (String origin : new String[]{"https://agent.example", "https://agent.example/prefix", "http://127.0.0.1:3333", "http://localhost:3333",
                "http://10.0.0.241:31725", "http://192.168.0.2:3333", "http://172.16.2.3:80", "http://[::1]:3333", "http://[fd00::1]:3333"})
            check(ClockHostPolicy.base(origin).toString().equals(origin), "Selected private/HTTPS origin must survive exactly");
        for (String origin : new String[]{"http://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://192.167.0.1", "http://0127.0.0.1",
                "https://user:secret@example.com", "https://example.com?token=x", "https://example.com#fragment", "file:///tmp/agent", "https://example.com/a/../b", "https://example.com/%2e%2e"})
            rejects(() -> ClockHostPolicy.base(origin));
        check(ClockHostPolicy.origin(ClockHostPolicy.base("https://agent.example:443/prefix")).equals("https://agent.example"), "Default HTTPS port origin mismatch");
        check(ClockHostPolicy.endpoint(ClockHostPolicy.base("https://agent.example/api/v1/eliza/agents/a"), "/api/client-devices/context").toString()
                .equals("https://agent.example/api/v1/eliza/agents/a/api/client-devices/context"), "Selected agent prefix changed");
        for (String path : new String[]{"https://evil.example/api/chat", "//evil.example/api/chat", "/api/a/../chat", "/api/%2f/clock", "/api/chat#x"}) {
            rejects(() -> ClockHostPolicy.endpoint(ClockHostPolicy.base("https://agent.example"), path));
            rejects(() -> ClockHostPolicy.agentPath("POST", path));
        }
        ClockHostPolicy.agentPath("POST", "/api/conversations/id/messages/stream"); checks++;
        ClockHostPolicy.agentPath("GET", "/api/conversations/id/messages?limit=50"); checks++;
        rejects(() -> ClockHostPolicy.agentPath("DELETE", "/api/conversations/id"));
        rejects(() -> ClockHostPolicy.agentPath("POST", "/api/client-devices/proposals/id/decision"));
        rejects(() -> ClockHostPolicy.agentPath("POST", "/api/conversations/id/messages?redirect=1"));
        rejects(() -> ClockHostPolicy.header("Authorization", "Bearer renderer"));
        rejects(() -> ClockHostPolicy.header("Cookie", "renderer=1"));
        rejects(() -> ClockHostPolicy.header("x-eliza-device-key", "renderer"));
        rejects(() -> ClockHostPolicy.header("accept", "application/json\r\nx:1"));
        ClockHostPolicy.header("accept", "text/event-stream"); checks++;

        AtomicInteger hits = new AtomicInteger(), redirected = new AtomicInteger();
        CountDownLatch firstChunk = new CountDownLatch(1);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/chat", exchange -> {
            hits.incrementAndGet();
            if (!"fixture-native-key".equals(exchange.getRequestHeaders().getFirst("x-eliza-device-key"))) throw new AssertionError("Native headers missing");
            byte[] body = exchange.getRequestBody().readAllBytes();
            if (!new String(body, StandardCharsets.UTF_8).equals("{\"fixture\":true}")) throw new AssertionError("Request body changed");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            byte[] data = "{\"accepted\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, data.length); exchange.getResponseBody().write(data); exchange.close();
        });
        server.createContext("/redirect", exchange -> {
            exchange.getResponseHeaders().set("Location", "/target"); exchange.sendResponseHeaders(302, -1); exchange.close();
        });
        server.createContext("/target", exchange -> { redirected.incrementAndGet(); exchange.sendResponseHeaders(200, -1); exchange.close(); });
        server.createContext("/stream", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream"); exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().write("data: first\n\n".getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush();
                if (!firstChunk.await(5, TimeUnit.SECONDS)) throw new AssertionError("Native stream buffered until completion");
                byte[] unicode = "data: 🌙 final\n\n".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseBody().write(unicode, 0, 8); exchange.getResponseBody().flush();
                exchange.getResponseBody().write(unicode, 8, unicode.length - 8); exchange.close();
            } catch (InterruptedException error) { throw new java.io.IOException(error); }
        });
        server.createContext("/oversize", exchange -> {
            exchange.sendResponseHeaders(200, 2 * 1024 * 1024 + 1); exchange.getResponseBody().write(new byte[2 * 1024 * 1024 + 1]); exchange.close();
        });
        server.start();
        try {
            String origin = "http://127.0.0.1:" + server.getAddress().getPort();
            ClockHostHttp.Response response = ClockHostHttp.request(URI.create(origin + "/api/chat"), "POST", "{\"fixture\":true}",
                    Map.of("x-eliza-device-key", "fixture-native-key", "Content-Type", "application/json"), () -> {}, null);
            check(response.status == 200 && response.data.equals("{\"accepted\":true}"), "Native HTTP response changed");
            rejects(() -> ClockHostHttp.request(URI.create(origin + "/redirect"), "GET", null, Map.of(), () -> {}, null));
            check(redirected.get() == 0, "Native credentials must never follow redirects");
            rejects(() -> ClockHostHttp.request(URI.create(origin + "/api/chat"), "POST", "{}", Map.of(), () -> { throw new SecurityException("stale fixture"); }, null));
            check(hits.get() == 1, "Stale native owner must fail before network dispatch");
            rejects(() -> ClockHostHttp.request(URI.create(origin + "/oversize"), "GET", null, Map.of(), () -> {}, null));
            StringBuilder chunks = new StringBuilder(); AtomicInteger heads = new AtomicInteger(), done = new AtomicInteger();
            ClockHostHttp.request(URI.create(origin + "/stream"), "GET", null, Map.of(), () -> {}, new ClockHostHttp.Stream() {
                @Override public void connected(java.net.HttpURLConnection ignored) {}
                @Override public void head(ClockHostHttp.Response head) { check(head.status == 200 && head.data.isEmpty(), "Stream head must precede data"); heads.incrementAndGet(); }
                @Override public void chunk(String data) { check(heads.get() == 1, "Data arrived before response head"); chunks.append(data); firstChunk.countDown(); }
                @Override public void done() { done.incrementAndGet(); }
                @Override public boolean cancelled() { return false; }
            });
            check(chunks.toString().equals("data: first\n\ndata: 🌙 final\n\n") && done.get() == 1, "Incremental Unicode SSE changed");
            check(firstChunk.getCount() == 0, "First native chunk must arrive before server completion");
        } finally { server.stop(0); }
        System.out.println("Native Clock host policy passed: " + checks + " checks; synthetic HTTP only, no Android UI/device effects");
    }
}
