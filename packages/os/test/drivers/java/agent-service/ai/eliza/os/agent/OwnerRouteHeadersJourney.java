// spec/os/agentService/channel.md, "Only admitted renderer headers accompany the service token"
package ai.eliza.os.agent;

import ai.eliza.os.agent.AgentSocketClient.HttpCall;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import org.json.JSONObject;

public final class OwnerRouteHeadersJourney {
  private static final String MESSAGES = "/api/conversations/example/messages";

  public static void main(String[] args) throws Exception {
    Map<String, String> device = Map.of(
      "X-Eliza-Device-Id", "fixture-device",
      "X-Eliza-Device-Key", "fixture-key",
      "X-ELIZA-Device-Capabilities", "calendar.agenda-read.v1",
      "X-ElizaOS-Client-Id", "fixture.client_1",
      "x-elizaos-cut-off-effect", "applied"
    );
    for (boolean streamed : new boolean[]{false, true}) {
      String path = streamed ? MESSAGES + "/stream" : MESSAGES;
      JSONObject request = sent(new HttpCall("POST", path, "{}".getBytes(StandardCharsets.UTF_8), streamed, device));
      check(request.getString("method").equals(streamed ? "http_request_stream" : "http_request"));
      JSONObject payload = request.getJSONObject("payload");
      check(payload.getString("path").equals(path));
      JSONObject headers = payload.getJSONObject("headers");
      check(headers.length() == 7);
      check(headers.getString("authorization").equals("Bearer fixture-root"));
      check(headers.getString("content-type").equals("application/json"));
      for (Map.Entry<String, String> entry : device.entrySet())
        check(headers.getString(entry.getKey().toLowerCase(java.util.Locale.ROOT)).equals(entry.getValue()));
    }
    check(sent(new HttpCall("GET", "/api/health", null, false)).getJSONObject("payload").getJSONObject("headers").length() == 1);
    refused(MESSAGES, Map.of("Authorization", "fixture-spoof"));
    refused(MESSAGES, Map.of("CONTENT-TYPE", "text/plain"));
    refused(MESSAGES, Map.of("X-Eliza-Device-Id", "one", "x-eliza-device-id", "two"));
    refused(MESSAGES, Map.of("X-ElizaOS-Client-Id", "bad client"));
    refused(MESSAGES, Map.of("X-Eliza-Device-Key", "bad\nline"));
    refused(MESSAGES, Map.of("X-Eliza-Device-Id", "x".repeat(2049)));
    refused(MESSAGES, Map.of("x-elizaos-cut-off-effect", "unknown"));
    refused("/api/health", Map.of("x-elizaos-cut-off-effect", "applied"));
    System.out.println("owner route header journey passed");
  }

  private static JSONObject sent(HttpCall call) throws Exception {
    ByteArrayOutputStream written = new ByteArrayOutputStream();
    String answer = "{\"id\":\"request-1\",\"ok\":true,\"result\":{\"status\":200}}\n";
    AgentSocketClient client = new AgentSocketClient(path -> new AgentSocketClient.Link() {
      @Override public InputStream input() { return new ByteArrayInputStream(answer.getBytes(StandardCharsets.UTF_8)); }
      @Override public OutputStream output() { return written; }
      @Override public void close() { }
    }, System::nanoTime);
    client.exchange(Path.of("/fixture/socket"), "fixture-root", "request-1", call, link -> { }, frame -> false);
    return new JSONObject(written.toString(StandardCharsets.UTF_8));
  }

  private static void refused(String path, Map<String, String> headers) {
    try { new HttpCall("POST", path, null, false, headers); }
    catch (IllegalArgumentException rejected) { return; }
    throw new AssertionError("The socket admitted an invalid renderer header");
  }

  private static void check(boolean expected) {
    if (!expected) throw new AssertionError("The socket changed the admitted owner request");
  }
}
