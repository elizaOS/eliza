package ai.eliza.plugins.agent.runtime;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/** Private loopback JSON transport. Hosts must authorize routes before calling. */
public final class LocalRuntimeHttp {
  private LocalRuntimeHttp() { }
  public static JSONObject exchange(int targetPort, String authorization, String method, String route, String body, int timeout, int maxBody, java.util.function.LongSupplier clock) throws Exception {
    if (maxBody < 1) throw new IllegalArgumentException("Response limit must be positive");
    if (authorization == null || authorization.indexOf('\r') >= 0 || authorization.indexOf('\n') >= 0
        || method == null || !method.matches("[A-Z]+") || route == null || !route.startsWith("/")
        || route.chars().anyMatch(c -> c <= 32 || c >= 127)) throw new IOException("Invalid runtime request framing");
    try (Socket socket = new Socket(); RuntimeRequestDeadline deadline = new RuntimeRequestDeadline(socket,timeout,clock)) {
      socket.connect(new InetSocketAddress("127.0.0.1", targetPort), Math.min(timeout, 2000)); socket.setSoTimeout(timeout);
      byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
      String header = method + " " + route + " HTTP/1.1\r\nHost: 127.0.0.1:" + targetPort + "\r\nAuthorization: Bearer " + authorization + "\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
      socket.getOutputStream().write(header.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().write(bytes);
      BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
      String status = line(in); int code = Integer.parseInt(status.split(" ")[1]);
      int length = -1; boolean chunked = false; int headerBytes = 0; String item;
      while (!(item = line(in)).isEmpty()) { if ((headerBytes += item.length()) > 16384) throw new IOException("Runtime response headers too large"); String lower = item.toLowerCase(Locale.ROOT); if (lower.startsWith("content-length:")) length = Integer.parseInt(item.substring(15).trim()); if (lower.startsWith("transfer-encoding:") && lower.contains("chunked")) chunked = true; }
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      if (chunked) { while (true) { int size = Integer.parseInt(line(in).split(";")[0].trim(), 16); if (size == 0) break; readBody(in, output, size, maxBody); if (!line(in).isEmpty()) throw new IOException("Malformed runtime response"); } }
      else if (length >= 0) readBody(in, output, length, maxBody);
      else { int value; while ((value = in.read()) >= 0) { if (output.size() >= maxBody) throw new IOException("Runtime response too large"); output.write(value); } }
      JSONObject data = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
      deadline.check();
      return new JSONObject().put("status", code).put("data", data);
    }
  }

  private static String line(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(); int value;
    while ((value = in.read()) >= 0 && value != '\n') { if (out.size() >= 16384) throw new IOException("Runtime response line too large"); out.write(value); }
    if (value < 0) throw new EOFException(); return new String(out.toByteArray(), StandardCharsets.US_ASCII).replaceAll("\\r$", "");
  }
  private static void readBody(InputStream in, ByteArrayOutputStream out, int size, int maxBody) throws IOException {
    if (size < 0 || size > maxBody - out.size()) throw new IOException("Runtime response too large");
    byte[] buffer = new byte[8192]; while (size > 0) { int count = in.read(buffer, 0, Math.min(buffer.length, size)); if (count < 0) throw new EOFException(); out.write(buffer, 0, count); size -= count; }
  }

}
