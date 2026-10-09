package ai.eliza.plugins.agent.contract;

import ai.eliza.plugins.agent.runtime.LocalCredentialBroker;
import java.io.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Android/JVM contract using independent stores and real TCP, without a product dependency. */
public final class LocalCredentialBrokerContract {
  private static final class MemoryStore implements LocalCredentialBroker.Store {
    String value;
    int calls;
    boolean fail;
    public String read() throws Exception { calls++; if (fail) throw new IOException("private-storage-detail"); return value; }
    public void write(String value) { calls++; this.value = value; }
    public void clear() { calls++; value = null; }
  }
  public static void main(String[] args) throws Exception { run(); System.out.println("Credential broker socket contract passed"); }
  public static void run() throws Exception {
    MemoryStore primary = new MemoryStore(), pending = new MemoryStore();
    try { new LocalCredentialBroker(primary, pending, ""); throw new AssertionError("Empty token accepted"); }
    catch (IllegalArgumentException expected) { }
    try (LocalCredentialBroker broker = new LocalCredentialBroker(primary, pending, "contract-token")) {
      String write = "{\"operation\":\"write\",\"value\":\"synthetic-primary\"}";
      for (String header : new String[]{"Origin: https://example.test\r\n", "Transfer-Encoding: chunked\r\n", "Authorization: Bearer contract-token\r\n", "Content-Length: -1\r\n"}) {
        check(exchange(broker.port(), header, write, "contract-token", "POST /credential HTTP/1.1", null), 403);
      }
      check(exchange(broker.port(), "", write, "wrong-token", "POST /credential HTTP/1.1", null), 403);
      check(exchange(broker.port(), "", write, "contract-token", "GET /credential HTTP/1.1", null), 403);
      check(exchange(broker.port(), "", "", "contract-token", "POST /credential HTTP/1.1", 20001), 413);
      require(primary.calls == 0 && pending.calls == 0, "Rejected requests accessed storage");
      check(exchange(broker.port(), "", write, "contract-token", "POST /credential HTTP/1.1", null), 200);
      check(operation(broker, "pending-write", "synthetic-pending"), 200);
      require(operation(broker, "read", null).getJSONObject("body").getString("value").equals("synthetic-primary"), "Primary changed");
      require(operation(broker, "pending-read", null).getJSONObject("body").getString("value").equals("synthetic-pending"), "Pending changed");
      check(operation(broker, "pending-clear", null), 200);
      require(pending.value == null && primary.value.equals("synthetic-primary"), "Store separation failed");
      int before = primary.calls;
      check(operation(broker, "unsupported", null), 503);
      check(exchange(broker.port(), "", "{", "contract-token", "POST /credential HTTP/1.1", null), 503);
      require(primary.calls == before, "Malformed operation accessed storage");
      primary.fail = true;
      JSONObject failed = operation(broker, "read", null); check(failed, 503);
      require(!failed.toString().contains("private-storage-detail"), "Storage details leaked");
      primary.fail = false;
      check(operation(broker, "clear", null), 200);
      require(operation(broker, "read", null).getJSONObject("body").isNull("value"), "Clear failed");
    }
  }
  private static JSONObject operation(LocalCredentialBroker broker, String operation, String value) throws Exception {
    JSONObject body = new JSONObject().put("operation", operation);
    if (value != null) body.put("value", value);
    return exchange(broker.port(), "", body.toString(), "contract-token", "POST /credential HTTP/1.1", null);
  }
  private static void check(JSONObject response, int status) throws Exception { require(response.getInt("status") == status, "Unexpected status: " + response.getInt("status")); }
  private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
  private static JSONObject exchange(int port, String extra, String body, String token, String request, Integer length) throws Exception {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    try (Socket socket = new Socket("127.0.0.1", port)) {
      socket.setSoTimeout(5000);
      socket.getOutputStream().write((request + "\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token + "\r\n" + extra + "Content-Length: " + (length == null ? bytes.length : length) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      socket.getOutputStream().write(bytes);
      BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
      int status = Integer.parseInt(reader.readLine().split(" ")[1]);
      String header; boolean noStore = false;
      while (!(header = reader.readLine()).isEmpty()) if (header.equals("Cache-Control: no-store")) noStore = true;
      require(noStore, "Response must prevent caching");
      StringBuilder result = new StringBuilder(); int c;
      while ((c = reader.read()) != -1) result.append((char)c);
      return new JSONObject().put("status", status).put("body", new JSONObject(result.toString()));
    }
  }
}
