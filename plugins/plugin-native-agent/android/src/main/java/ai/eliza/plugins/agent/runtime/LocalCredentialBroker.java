package ai.eliza.plugins.agent.runtime;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Private process-to-process bridge; never registered as a Capacitor API. */
public final class LocalCredentialBroker implements AutoCloseable {
  private final ServerSocket server;
  private final Store store;
  private final Store pending;
  private final String token;
  /** Native-only storage port. Do not expose this broker or its token to a renderer. */
  public interface Store {
    String read() throws Exception;
    void write(String value) throws Exception;
    void clear() throws Exception;
  }
  public LocalCredentialBroker(Store store, Store pending, String token) throws IOException {
    this.store = java.util.Objects.requireNonNull(store);
    this.pending = java.util.Objects.requireNonNull(pending);
    if (token == null || token.isEmpty()) throw new IllegalArgumentException("Broker token required");
    this.token = token;
    server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
    Thread thread = new Thread(this::serve, "AccountCredentialBroker"); thread.setDaemon(true); thread.start();
  }
  public int port() { return server.getLocalPort(); }
  private void serve() {
    while (!server.isClosed()) {
      try (Socket socket = server.accept()) { socket.setSoTimeout(3000); handle(socket); }
      catch (Exception ignored) { /* Fail closed without logging credential-bearing input. */ }
    }
  }
  private void handle(Socket socket) throws Exception {
    BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
    String request = line(input); int length = -1, count = 0; String authorization = null, header;
    boolean forbidden = false, hasLength = false;
    while (!(header = line(input)).isEmpty()) {
      if ((count += header.length()) > 8192) throw new IOException("Headers too large");
      int split = header.indexOf(':'); if (split < 1) throw new IOException("Invalid header");
      String name = header.substring(0, split).toLowerCase(java.util.Locale.ROOT), value = header.substring(split + 1).trim();
      if (name.equals("authorization")) { if (authorization != null) forbidden = true; authorization = value; }
      if (name.equals("content-length")) { if (hasLength) forbidden = true; hasLength = true; length = Integer.parseInt(value); }
      if (name.equals("origin") || name.equals("transfer-encoding")) forbidden = true;
    }
    if (forbidden || !request.equals("POST /credential HTTP/1.1") || authorization == null || !MessageDigest.isEqual(authorization.getBytes(StandardCharsets.UTF_8), ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) {
      // Consume only a bounded declared body, without parsing or touching storage.
      // Closing with unread TCP bytes can reset the connection before 403 arrives.
      if (length >= 0 && length <= 20000) {
        byte[] discard = new byte[1024]; int remaining = length;
        while (remaining > 0) { int n = input.read(discard, 0, Math.min(discard.length, remaining)); if (n < 0) break; remaining -= n; }
      }
      respond(socket, 403, new JSONObject().put("error", "Forbidden")); return;
    }
    if (length < 0 || length > 20000) { respond(socket, 413, new JSONObject().put("error", "Invalid body")); return; }
    byte[] bytes = new byte[length]; int offset = 0;
    while (offset < length) { int n = input.read(bytes, offset, length - offset); if (n < 0) throw new EOFException(); offset += n; }
    try {
      JSONObject body = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); String operation = body.getString("operation");
      JSONObject result = new JSONObject();
      switch (operation) {
        case "read": String value = store.read(); result.put("value", value == null ? JSONObject.NULL : value); break;
        case "write": store.write(body.getString("value")); break;
        case "clear": store.clear(); break;
        case "pending-read": String pendingValue = pending.read(); result.put("value", pendingValue == null ? JSONObject.NULL : pendingValue); break;
        case "pending-write": pending.write(body.getString("value")); break;
        case "pending-clear": pending.clear(); break;
        default: throw new IOException("Unsupported operation");
      }
      respond(socket, 200, result);
    } catch (Exception failure) { respond(socket, 503, new JSONObject().put("error", "Native account storage unavailable")); }
  }
  private static String line(InputStream input) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(); int value;
    while ((value = input.read()) != -1 && value != '\n') { if (out.size() > 8192) throw new IOException("Invalid headers"); out.write(value); }
    if (value == -1) throw new EOFException(); return out.toString("US-ASCII").replaceAll("\\r$", "");
  }
  private static void respond(Socket socket, int status, JSONObject body) throws IOException {
    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
    socket.getOutputStream().write(("HTTP/1.1 " + status + " Result\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().write(bytes);
  }
  @Override public void close() { try { server.close(); } catch (IOException ignored) { } }
}
