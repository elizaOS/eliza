package ai.eliza.plugins.agent.contract;

import ai.eliza.plugins.agent.runtime.LocalRuntimeHttp;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
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
  }
  private static void reject(String response, long delay, int limit, int timeout) throws Exception {
    try { exchange(response, delay, limit, timeout); throw new AssertionError("Invalid or late response accepted"); }
    catch (IOException expected) { }
  }
  private static JSONObject exchange(String response, long delay, int limit, int timeout) throws Exception {
    AtomicReference<Throwable> failure = new AtomicReference<>();
    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
      server.setSoTimeout(3000);
      Thread peer = new Thread(() -> {
        try (Socket socket = server.accept()) {
          socket.setSoTimeout(3000);
          BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
          require("POST /host-selected HTTP/1.1".equals(input.readLine()), "Host route changed");
          boolean authorized = false; String line;
          while (!(line = input.readLine()).isEmpty()) if (line.equals("Authorization: Bearer synthetic-http-authority")) authorized = true;
          require(authorized, "Native authority missing");
          require(input.read() == '{' && input.read() == '}', "Request body changed");
          if (delay > 0) Thread.sleep(delay);
          socket.getOutputStream().write(response.getBytes(StandardCharsets.UTF_8));
        } catch (SocketException expectedAfterDeadline) { if (delay == 0) failure.set(expectedAfterDeadline); }
        catch (Throwable error) { failure.set(error); }
      }, "RuntimeHttpContract");
      peer.setDaemon(true); peer.start();
      try { return LocalRuntimeHttp.exchange(server.getLocalPort(), "synthetic-http-authority", "POST", "/host-selected", "{}", timeout, limit, System::nanoTime); }
      finally {
        peer.join(4000);
        require(!peer.isAlive(), "Peer did not stop");
        if (failure.get() != null) throw new AssertionError("Loopback peer failed", failure.get());
      }
    }
  }
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
