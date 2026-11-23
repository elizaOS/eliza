package ai.eliza.plugins.agent.runtime;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Private loopback JSON transport. Hosts must authorize routes before calling. */
public final class LocalRuntimeHttp {
  private LocalRuntimeHttp() { }
  /** One data payload of a server-sent event, in arrival order. */
  @FunctionalInterface public interface Events { void data(String data) throws Exception; }
  public static JSONObject exchange(int targetPort, String authorization, String method, String route, String body, int timeout, int maxBody, java.util.function.LongSupplier clock) throws Exception {
    return exchange(targetPort, authorization, method, route, body, Map.of(), timeout, maxBody, clock);
  }
  /** As above, with host-chosen request headers (for example a correlation ID). A header may not
   * replace one this transport sets, and every name and value is checked before connecting. */
  public static JSONObject exchange(int targetPort, String authorization, String method, String route, String body, Map<String, String> headers, int timeout, int maxBody, java.util.function.LongSupplier clock) throws Exception {
    String extra = requestHeaders(headers);
    if (maxBody < 1) throw new IllegalArgumentException("Response limit must be positive");
    requireFraming(authorization, method, route);
    try (Socket socket = new Socket(); RuntimeRequestDeadline deadline = new RuntimeRequestDeadline(socket,timeout,clock)) {
      socket.connect(new InetSocketAddress("127.0.0.1", targetPort), Math.min(timeout, 2000)); socket.setSoTimeout(timeout);
      Head head = send(socket, targetPort, authorization, method, route, body, extra);
      JSONObject data = new JSONObject(new String(readAll(head.body, maxBody), StandardCharsets.UTF_8));
      deadline.check();
      return new JSONObject().put("status", head.status).put("data", data);
    }
  }

  /** A server-sent event request over a socket the caller owns: closing it from another thread
   * aborts the request, which the runtime sees as a disconnect. Each event's data reaches
   * {@code events} as it arrives, and the result is {status}. A response that is not an event
   * stream is read as JSON, and the result is {status, data} as for {@link #exchange}. A gap
   * between bytes longer than {@code idleTimeout} ends the request. */
  public static JSONObject stream(Socket socket, int targetPort, String authorization, String method, String route, String body, int idleTimeout, int maxBody, Events events) throws Exception {
    if (maxBody < 1 || idleTimeout < 1) throw new IllegalArgumentException("Stream limits must be positive");
    requireFraming(authorization, method, route);
    socket.connect(new InetSocketAddress("127.0.0.1", targetPort), Math.min(idleTimeout, 2000)); socket.setSoTimeout(idleTimeout);
    Head head = send(socket, targetPort, authorization, method, route, body, "Accept: text/event-stream\r\n");
    if (!head.contentType.startsWith("text/event-stream"))
      return new JSONObject().put("status", head.status).put("data", new JSONObject(new String(readAll(head.body, maxBody), StandardCharsets.UTF_8)));
    StringBuilder data = null; String line;
    while ((line = textLine(head.body, maxBody)) != null) {
      if (line.isEmpty()) { if (data != null) events.data(data.toString()); data = null; }
      else if (line.startsWith("data:")) {
        String value = line.substring(line.startsWith("data: ") ? 6 : 5);
        if (data == null) data = new StringBuilder(value); else data.append('\n').append(value);
        if (data.length() > maxBody) throw new IOException("Runtime event too large");
      }
    }
    if (data != null) events.data(data.toString());
    return new JSONObject().put("status", head.status);
  }

  private static final class Head {
    final int status; final String contentType; final InputStream body;
    Head(int status, String contentType, InputStream body) { this.status = status; this.contentType = contentType; this.body = body; }
  }
  private static void requireFraming(String authorization, String method, String route) throws IOException {
    if (authorization == null || authorization.indexOf('\r') >= 0 || authorization.indexOf('\n') >= 0
        || method == null || !method.matches("[A-Z]+") || route == null || !route.startsWith("/")
        || route.chars().anyMatch(c -> c <= 32 || c >= 127)) throw new IOException("Invalid runtime request framing");
  }
  private static Head send(Socket socket, int targetPort, String authorization, String method, String route, String body, String extra) throws IOException {
    byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
    String header = method + " " + route + " HTTP/1.1\r\nHost: 127.0.0.1:" + targetPort + "\r\nAuthorization: Bearer " + authorization + "\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n" + extra + "\r\n";
    socket.getOutputStream().write(header.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().write(bytes);
    BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
    String status = line(in); int code = Integer.parseInt(status.split(" ")[1]);
    int length = -1; boolean chunked = false; int headerBytes = 0; String contentType = "", item;
    while (!(item = line(in)).isEmpty()) {
      if ((headerBytes += item.length()) > 16384) throw new IOException("Runtime response headers too large");
      String lower = item.toLowerCase(Locale.ROOT);
      if (lower.startsWith("content-length:")) length = Integer.parseInt(item.substring(15).trim());
      if (lower.startsWith("transfer-encoding:") && lower.contains("chunked")) chunked = true;
      if (lower.startsWith("content-type:")) contentType = lower.substring(13).trim();
    }
    return new Head(code, contentType, chunked ? new Chunked(in) : length >= 0 ? new Limited(in, length) : in);
  }

  private static final Set<String> OWNED_HEADERS = Set.of("host", "authorization", "content-type", "content-length", "connection", "transfer-encoding");
  /** Header lines for the host's own headers; rejects anything that could change the request framing. */
  private static String requestHeaders(Map<String, String> headers) throws IOException {
    if (headers == null || headers.size() > 8) throw new IOException("Invalid runtime request framing");
    StringBuilder lines = new StringBuilder(); Set<String> seen = new HashSet<>();
    for (Map.Entry<String, String> header : headers.entrySet()) {
      String name = header.getKey(), value = header.getValue();
      if (name == null || !name.matches("[A-Za-z0-9-]{1,64}") || value == null || value.isEmpty() || value.length() > 512
          || value.charAt(0) == ' ' || value.charAt(value.length() - 1) == ' ' || value.chars().anyMatch(c -> c < 32 || c >= 127)
          || OWNED_HEADERS.contains(name.toLowerCase(Locale.ROOT)) || !seen.add(name.toLowerCase(Locale.ROOT)))
        throw new IOException("Invalid runtime request framing");
      lines.append(name).append(": ").append(value).append("\r\n");
    }
    return lines.toString();
  }
  private static EOFException cut() { return new EOFException("The agent closed the response before it ended"); }
  private static String line(InputStream in) throws IOException {
    String value = textLine(in, 16384);
    if (value == null) throw cut();
    return value;
  }
  private static String textLine(InputStream in, int limit) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(); int value;
    while ((value = in.read()) >= 0 && value != '\n') { if (out.size() >= limit) throw new IOException("Runtime response line too large"); out.write(value); }
    if (value < 0 && out.size() == 0) return null;
    return new String(out.toByteArray(), StandardCharsets.UTF_8).replaceAll("\\r$", "");
  }
  private static byte[] readAll(InputStream in, int maxBody) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
    while ((count = in.read(buffer)) >= 0) { if (count > maxBody - out.size()) throw new IOException("Runtime response too large"); out.write(buffer, 0, count); }
    return out.toByteArray();
  }

  private static final class Limited extends FilterInputStream {
    private long remaining;
    Limited(InputStream in, long length) { super(in); remaining = length; }
    @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) < 0 ? -1 : one[0] & 255; }
    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
      if (remaining == 0) return -1;
      int count = in.read(buffer, offset, (int) Math.min(length, remaining));
      if (count < 0) throw cut();
      remaining -= count; return count;
    }
  }
  private static final class Chunked extends FilterInputStream {
    private int remaining; private boolean started, ended;
    Chunked(InputStream in) { super(in); }
    @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) < 0 ? -1 : one[0] & 255; }
    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
      if (ended) return -1;
      if (remaining == 0) {
        if (started && !line(in).isEmpty()) throw new IOException("Malformed runtime response");
        started = true;
        remaining = Integer.parseInt(line(in).split(";")[0].trim(), 16);
        if (remaining < 0) throw new IOException("Malformed runtime response");
        if (remaining == 0) { ended = true; return -1; }
      }
      int count = in.read(buffer, offset, Math.min(length, remaining));
      if (count < 0) throw cut();
      remaining -= count; return count;
    }
  }
}
