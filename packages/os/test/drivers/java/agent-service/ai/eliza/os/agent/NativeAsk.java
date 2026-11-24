// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"
package ai.eliza.os.agent;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

public final class NativeAsk {
  private static final String CONTEXT = "/api/client-devices/context";

  public static void main(String[] args) throws Exception {
    AgentSocketClient echo = new AgentSocketClient(socket -> new AgentSocketClient.Link() {
      private final ByteArrayOutputStream sent = new ByteArrayOutputStream();
      @Override public OutputStream output() { return sent; }
      @Override public InputStream input() {
        JSONObject frame = new JSONObject(sent.toString(StandardCharsets.UTF_8).trim());
        JSONObject headers = frame.getJSONObject("payload").getJSONObject("headers");
        headers.remove("authorization");
        String body = Base64.getEncoder().encodeToString(headers.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject answer = new JSONObject().put("id", frame.getString("id")).put("ok", true).put("result", new JSONObject().put("status", 200).put("bodyBase64", body));
        return new ByteArrayInputStream((answer + "\n").getBytes(StandardCharsets.UTF_8));
      }
      @Override public void close() { }
    }, System::nanoTime);
    AgentChannel channel = new AgentChannel(new ChannelPolicy(), echo);
    if (!channel.policy().loadRouteTable(ChannelPolicy.CallerKind.NATIVE, "[{\"method\":\"GET\",\"path\":\"" + CONTEXT + "\"}]")) throw new IllegalStateException("native routes refused");
    if (!channel.open(1, "root-token", Path.of("agent.sock"))) throw new IllegalStateException("channel refused the launch");
    JSONObject out = new JSONObject()
      .put("described", ask(channel, Map.of("X-Eliza-Device-Id", "device-1", "X-Eliza-Device-Key", "a".repeat(64), "X-Eliza-Device-Capabilities", "notes.query.v1")))
      .put("credential", ask(channel, Map.of("X-Eliza-Device-Token", "secret")))
      .put("bare", ask(channel, Map.of()));
    System.out.println(out);
    System.exit(0);
  }

  private static Object ask(AgentChannel channel, Map<String, ?> headers) throws InterruptedException {
    try {
      AgentChannel.Response response = channel.request(ChannelPolicy.CallerKind.NATIVE, "GET", CONTEXT, null, headers).get(10, TimeUnit.SECONDS);
      return new JSONObject(new String(response.body(), StandardCharsets.UTF_8));
    } catch (ExecutionException refused) {
      return refused.getCause().getMessage();
    } catch (TimeoutException late) {
      return "no answer";
    }
  }
}
