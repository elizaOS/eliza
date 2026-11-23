package ai.eliza.plugins.agent.embedded.test;

import ai.eliza.plugins.agent.embedded.EmbeddedAgentConfig;
import ai.eliza.plugins.agent.runtime.LocalRuntimeHttp;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

public final class EmbeddedAgentTest {
  static int checks;
  static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
  static String merged(JSONObject valid, JSONObject changed, String file) {
    JSONObject value = new JSONObject(valid.getJSONObject(file).toString());
    JSONObject replaced = changed.optJSONObject(file);
    if (replaced != null) for (String key : replaced.keySet()) value.put(key, replaced.get(key));
    return value.toString();
  }

  public static void main(String[] args) throws Exception {
    JSONObject data = new JSONObject(new String(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[0])), StandardCharsets.UTF_8));
    JSONObject valid = data.getJSONObject("valid");
    for (Object entry : data.getJSONArray("refused")) {
      JSONObject changed = (JSONObject) entry;
      try { EmbeddedAgentConfig.parse(merged(valid, changed, "host"), merged(valid, changed, "character"), merged(valid, changed, "policy")); check(false); }
      catch (IOException expected) { check(true); }
    }
    JSONObject none = new JSONObject();
    EmbeddedAgentConfig config = EmbeddedAgentConfig.parse(merged(valid, none, "host"), merged(valid, none, "character"), merged(valid, none, "policy"));
    check(config.service.equals("example.consumer.HelperService") && config.notification.text.equals("Helper is ready"));
    check(config.admit("GET", "/api/status") != null && !config.admit("GET", "/api/status").stream);
    check(config.admit("POST", "/api/conversations/3f2a-91/messages/stream").stream);
    check(config.admit("POST", "/api/turns/room-1/abort") != null);
    for (String[] request : new String[][]{{"POST", "/api/status"}, {"GET", "/api/status?x=1"}, {"GET", "/api/config"},
        {"POST", "/api/conversations/a/b/messages/stream"}, {"POST", "/api/turns/../abort"}, {"DELETE", "/api/conversations"}})
      check(config.admit(request[0], request[1]) == null);

    Map<String, String> env = config.agentEnvironment("cloud-key-1");
    check(env.get("ELIZA_PROVIDER").equals("elizacloud") && env.get("ELIZAOS_CLOUD_USE_INFERENCE").equals("true"));
    check(env.get("ELIZAOS_CLOUD_API_KEY").equals("cloud-key-1") && env.get("ELIZAOS_CLOUD_BASE_URL").equals("https://cloud.example"));
    check(env.get("ELIZA_ACTION_ALLOWLIST").equals("[\"NONE\",\"REPLY\"]") && env.get("ELIZA_PLUGIN_SET").equals("lean-chat"));
    check(env.get("ELIZAOS_CLOUD_LARGE_MODEL").equals("large-1") && env.get("ELIZA_PAIRING_DISABLED").equals("1"));
    check(env.get("ELIZA_DEPLOYMENT_RUNTIME").equals("cloud") && env.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS").equals("1"));
    JSONObject agent = config.agentConfig();
    check(agent.getJSONObject("serviceRouting").getJSONObject("llmText").getString("backend").equals("elizacloud"));
    check(agent.getJSONObject("serviceRouting").getJSONObject("embeddings").getString("transport").equals("cloud-proxy"));
    check(agent.getJSONObject("agents").getJSONArray("list").getJSONObject(0).getBoolean("default"));
    check(agent.getJSONObject("plugins").getJSONArray("deny").getString(0).equals("@elizaos/plugin-browser"));
    check(agent.getJSONObject("database").getJSONObject("pglite").getString("dataDir").equals("memory://"));
    for (String unusable : Arrays.asList(null, "two words", "cl\u00e9"))
      try { config.agentEnvironment(unusable); check(false); } catch (IllegalArgumentException refused) { check(true); }

    try (ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))) {
      ExecutorService agentSide = Executors.newCachedThreadPool();
      CountDownLatch held = new CountDownLatch(1);
      agentSide.execute(() -> {
        for (String mode : List.of("events", "refusal", "cut", "held")) try (Socket socket = server.accept()) {
          BufferedReader request = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
          String line; boolean authorized = false;
          while (!(line = request.readLine()).isEmpty()) authorized |= line.equals("Authorization: Bearer agent-token");
          OutputStream out = socket.getOutputStream();
          if (!authorized || mode.equals("refusal")) {
            out.write("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"error\":\"busy\"}".getBytes(StandardCharsets.UTF_8));
            continue;
          }
          out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".getBytes(StandardCharsets.UTF_8));
          for (String frame : !mode.equals("events") ? List.of("data: {\"text\":\"Hel\"}\n\n") : List.of("data: {\"text\":\"Hé\"}\n\n", ": keep\n\ndata: line one\ndata: line two\n\n", "data: [DONE]\n\n")) {
            byte[] bytes = frame.getBytes(StandardCharsets.UTF_8);
            out.write((Integer.toHexString(bytes.length) + "\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(bytes); out.write("\r\n".getBytes(StandardCharsets.US_ASCII)); out.flush();
          }
          if (mode.equals("cut")) continue;
          if (mode.equals("held")) { held.countDown(); socket.getInputStream().read(); }
          else out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        } catch (IOException closed) { }
      });
      List<String> frames = new ArrayList<>();
      JSONObject done = LocalRuntimeHttp.stream(new Socket(), server.getLocalPort(), "agent-token", "POST", "/api/conversations/c1/messages/stream", "{\"text\":\"hi\"}", 5000, 65536, frames::add);
      check(done.getInt("status") == 200 && !done.has("data"));
      check(frames.equals(List.of("{\"text\":\"Hé\"}", "line one\nline two", "[DONE]")));
      JSONObject refusal = LocalRuntimeHttp.stream(new Socket(), server.getLocalPort(), "agent-token", "POST", "/api/conversations/c1/messages/stream", null, 5000, 65536, frames::add);
      check(refusal.getInt("status") == 409 && refusal.getJSONObject("data").getString("error").equals("busy"));
      Socket crashed = new Socket();
      try { LocalRuntimeHttp.stream(crashed, server.getLocalPort(), "agent-token", "POST", "/api/conversations/c1/messages/stream", null, 5000, 65536, frames::add); check(false); }
      catch (IOException cut) { check(cut.getMessage() != null && !cut.getMessage().isEmpty()); }
      Socket aborted = new Socket();
      List<String> partial = new CopyOnWriteArrayList<>();
      CountDownLatch arrived = new CountDownLatch(1);
      agentSide.execute(() -> { try { held.await(); arrived.await(5, TimeUnit.SECONDS); aborted.close(); } catch (Exception ignored) { } });
      try { LocalRuntimeHttp.stream(aborted, server.getLocalPort(), "agent-token", "POST", "/api/conversations/c1/messages/stream", null, 5000, 65536, event -> { partial.add(event); arrived.countDown(); }); check(false); }
      catch (IOException closed) { check(aborted.isClosed() && partial.equals(List.of("{\"text\":\"Hel\"}"))); }
      agentSide.shutdownNow();
    }
    System.out.println("PASS embedded agent: " + checks + " checks");
  }
}
