package ai.eliza.plugins.agent.contract;

import ai.eliza.plugins.agent.runtime.LocalRuntimeHttp;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Real loopback responses: framing, bounds, cancellation deadline and host authority. */
public final class LocalRuntimeHttpContract {
  public static void main(String[] args) throws Exception { run(); System.out.println("Runtime HTTP socket contract passed"); }
  public static void run() throws Exception {
    for (String framing : new String[]{"Content-Length: 11\r\n", "Transfer-Encoding: chunked\r\n", ""}) {
      String body = framing.startsWith("Transfer") ? "b\r\n{\"ok\":true}\r\n0\r\n\r\n" : "{\"ok\":true}";
      JSONObject result = exchange("HTTP/1.1 202 Accepted\r\n" + framing + "\r\n" + body, 0, 1024, 2000);
      require(result.getInt("status") == 202 && result.getJSONObject("data").getBoolean("ok"), "Response changed");
    }
    reject("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", 0, 10, 2000);
    reject("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n", 0, 10, 2000);
    reject("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}", 0, 10, 2000);
    reject("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{}", 0, 1024, 2000);
    reject("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", 250, 1024, 80);
    try { LocalRuntimeHttp.exchange(1, "token", "GET", "/health\r\nInjected: yes", null, 100, 1024, System::nanoTime); throw new AssertionError("Unsafe request framing accepted"); }
    catch (IOException expected) { require(expected.getMessage().equals("Invalid runtime request framing"), "Connected before framing validation"); }
    headers();
  }
  /** Host headers reach the runtime as sent; unsafe or transport-owned ones never open a socket. */
  private static void headers() throws Exception {
    Map<String, String> sent = new LinkedHashMap<>();
    sent.put("X-Host-Correlation", "v1;task=7;req=abc 123"); sent.put("x-second", "~");
    List<String> seen = new ArrayList<>();
    JSONObject result = exchange("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", 0, 1024, 2000, sent, seen);
    require(result.getInt("status") == 200, "Response changed");
    require(seen.contains("X-Host-Correlation: v1;task=7;req=abc 123") && seen.contains("x-second: ~"), "Host header changed");
    for (String owned : new String[]{"Host", "Authorization", "Content-Type", "Content-Length", "Connection", "Transfer-Encoding"})
      require(Collections.frequency(lower(seen), owned.toLowerCase(Locale.ROOT)) <= 1, "Transport header repeated");
    Map<String, String> most = new LinkedHashMap<>(); most.put("x".repeat(64), "v".repeat(256)); for (int i = 1; i < 8; i++) most.put("x-" + i, "v");
    List<String> bounded = new ArrayList<>();
    require(exchange("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", 0, 1024, 2000, most, bounded).getInt("status") == 200, "Largest allowed headers rejected");
    require(bounded.contains("x".repeat(64) + ": " + "v".repeat(256)) && bounded.contains("x-7: v"), "Largest allowed headers changed");
    Map<String, String> many = new LinkedHashMap<>(); for (int i = 0; i < 9; i++) many.put("x-" + i, "v");
    Map<String, String> twice = new LinkedHashMap<>(); twice.put("x-a", "1"); twice.put("X-A", "2");
    List<Map<String, String>> unsafe = new ArrayList<>(List.of(many, twice));
    unsafe.add(null);
    for (String name : new String[]{"", "x y", "x:y", "x\r\ny", "x".repeat(65), "authorization", "Host", "CONTENT-LENGTH", "content-type", "Connection", "transfer-encoding"})
      unsafe.add(Collections.singletonMap(name, "v"));
    for (String value : new String[]{"", " v", "v ", "a\r\nInjected: yes", "a\nb", "a\tb", "caf\u00e9", "v".repeat(257)})
      unsafe.add(Collections.singletonMap("x-host", value));
    unsafe.add(Collections.singletonMap("x-host", null)); unsafe.add(Collections.singletonMap(null, "v"));
    for (Map<String, String> headers : unsafe) {
      try { LocalRuntimeHttp.exchange(1, "token", "GET", "/health", null, headers, 100, 1024, System::nanoTime); throw new AssertionError("Unsafe request header accepted: " + headers); }
      catch (IOException expected) { require("Invalid runtime request framing".equals(expected.getMessage()), "Connected before header validation: " + headers); }
    }
  }
  private static List<String> lower(List<String> lines) {
    List<String> names = new ArrayList<>();
    for (String line : lines) names.add(line.substring(0, Math.max(0, line.indexOf(':'))).toLowerCase(Locale.ROOT));
    return names;
  }
  private static void reject(String response, long delay, int limit, int timeout) throws Exception {
    try { exchange(response, delay, limit, timeout); throw new AssertionError("Invalid or late response accepted"); }
    catch (IOException expected) { }
  }
  private static JSONObject exchange(String response, long delay, int limit, int timeout) throws Exception {
    return exchange(response, delay, limit, timeout, null, new ArrayList<>());
  }
  private static JSONObject exchange(String response, long delay, int limit, int timeout, Map<String, String> headers, List<String> seen) throws Exception {
    AtomicReference<Throwable> failure = new AtomicReference<>();
    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
      server.setSoTimeout(3000);
      Thread peer = new Thread(() -> {
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(3000);
          BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
          require("POST /host-selected HTTP/1.1".equals(input.readLine()), "Host route changed");
          boolean authorized = false; String line;
          while (!(line = input.readLine()).isEmpty()) { seen.add(line); if (line.equals("Authorization: Bearer synthetic-http-authority")) authorized = true; }
          require(authorized, "Native authority missing");
          require(input.read() == '{' && input.read() == '}', "Request body changed");
          if (delay > 0) Thread.sleep(delay);
          socket.getOutputStream().write(response.getBytes(StandardCharsets.UTF_8));
        } catch (SocketException expectedAfterDeadline) { if (delay == 0) failure.set(expectedAfterDeadline); }
        catch (Throwable error) { failure.set(error); }
      }, "RuntimeHttpContract");
      peer.setDaemon(true); peer.start();
      try {
        return headers == null
            ? LocalRuntimeHttp.exchange(server.getLocalPort(), "synthetic-http-authority", "POST", "/host-selected", "{}", timeout, limit, System::nanoTime)
            : LocalRuntimeHttp.exchange(server.getLocalPort(), "synthetic-http-authority", "POST", "/host-selected", "{}", headers, timeout, limit, System::nanoTime);
      }
      finally {
        peer.join(4000);
        require(!peer.isAlive(), "Peer did not stop");
        if (failure.get() != null) throw new AssertionError("Loopback peer failed", failure.get());
      }
    }
  }
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
