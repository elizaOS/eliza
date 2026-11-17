package ai.eliza.plugins.agent.runtime;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Base64;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.UUID;
import org.json.JSONObject;

public final class LocalRuntimeSocket {
  private static final int FRAME_LIMIT = 24 * 1024 * 1024;
  @FunctionalInterface public interface Events { void data(String value) throws Exception; }

  public static JSONObject exchange(Path path, String token, String method, String route, String body, int timeout) throws Exception {
    try (LocalSocket socket = new LocalSocket()) {
      String id = send(socket, path, token, method, route, body, timeout, "http_request");
      JSONObject frame = frame(new BufferedInputStream(socket.getInputStream()), id);
      if (!frame.getBoolean("ok")) throw new IOException("Agent request was refused");
      JSONObject result = frame.getJSONObject("result");
      Object content = result.opt("body");
      if (content instanceof String text) content = new JSONObject(text);
      if (!(content instanceof JSONObject)) throw new IOException("Agent response is not a JSON object");
      return new JSONObject().put("status", result.getInt("status")).put("data", content);
    }
  }

  public static JSONObject stream(LocalSocket socket, Path path, String token, String method, String route, String body,
      int timeout, int bodyLimit, Events events) throws Exception {
    String id = send(socket, path, token, method, route, body, timeout, "http_request_stream");
    InputStream input = new BufferedInputStream(socket.getInputStream());
    JSONObject head = frame(input, id);
    if (!"response".equals(head.getString("stream"))) throw new IOException("Agent stream did not begin");
    JSONObject response = new JSONObject().put("status", head.getInt("status"));
    boolean sse = head.getJSONObject("headers").optString("content-type").startsWith("text/event-stream");
    ByteArrayOutputStream buffered = new ByteArrayOutputStream();
    StringBuilder event = new StringBuilder();
    while (true) {
      JSONObject next = frame(input, id);
      String kind = next.getString("stream");
      if (kind.equals("complete")) {
        if (next.has("error")) throw new IOException("Agent stream failed");
        if (sse) {
          if (buffered.size() != 0 || event.length() != 0) throw new IOException("Agent ended an incomplete event");
        } else if (buffered.size() > 0) response.put("data", new JSONObject(new String(buffered.toByteArray(), StandardCharsets.UTF_8)));
        return response;
      }
      if (!kind.equals("chunk")) throw new IOException("Unexpected agent stream frame");
      byte[] bytes = Base64.decode(next.getString("dataBase64"), Base64.DEFAULT);
      if (!sse) {
        if (buffered.size() + bytes.length > bodyLimit) throw new IOException("Agent response is too large");
        buffered.write(bytes);
        continue;
      }
      for (byte value : bytes) {
        if (value == '\n') {
          String line = new String(buffered.toByteArray(), StandardCharsets.UTF_8);
          buffered.reset();
          if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
          if (line.isEmpty() && event.length() > 0) {
            events.data(event.toString());
            event.setLength(0);
          } else if (line.startsWith("data:")) {
            String data = line.substring(line.startsWith("data: ") ? 6 : 5);
            if (event.length() > 0) event.append('\n');
            event.append(data);
          }
        } else buffered.write(value);
        if (buffered.size() + event.length() > bodyLimit) throw new IOException("Agent event is too large");
      }
    }
  }

  private static String send(LocalSocket socket, Path path, String token, String method, String route, String body, int timeout, String mode) throws Exception {
    socket.connect(new LocalSocketAddress(path.toString(), LocalSocketAddress.Namespace.FILESYSTEM));
    socket.setSoTimeout(timeout);
    String id = UUID.randomUUID().toString();
    JSONObject headers = new JSONObject().put("authorization", "Bearer " + token).put("content-type", "application/json");
    JSONObject payload = new JSONObject().put("path", route).put("method", method).put("headers", headers);
    if (body != null) payload.put("body", body);
    JSONObject request = new JSONObject().put("id", id).put("method", mode).put("payload", payload);
    byte[] bytes = (request.toString() + "\n").getBytes(StandardCharsets.UTF_8);
    if (bytes.length > FRAME_LIMIT) throw new IOException("Agent request is too large");
    var output = socket.getOutputStream();
    output.write(bytes);
    output.flush();
    return id;
  }

  private static JSONObject frame(InputStream input, String id) throws Exception {
    ByteArrayOutputStream data = new ByteArrayOutputStream();
    for (int value; (value = input.read()) >= 0;) {
      if (value == '\n') {
        JSONObject frame = new JSONObject(new String(data.toByteArray(), StandardCharsets.UTF_8));
        if (!id.equals(frame.optString("id"))) throw new IOException("Agent answered another request");
        return frame;
      }
      if (data.size() >= FRAME_LIMIT) throw new IOException("Agent response is too large");
      data.write(value);
    }
    throw new IOException("Agent closed the connection before answering");
  }
}
