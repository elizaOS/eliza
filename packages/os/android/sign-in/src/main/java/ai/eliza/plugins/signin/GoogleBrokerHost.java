// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail and calendar without holding a mail credential"; spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a POST to its private path on the loopback host, without an origin, with its bearer and at most 8 KiB"; spec/os/signIn/cloudRequests.md, "The broker reads only Gmail status and search, and the calendar list and feed, each through listed GET routes"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body within the operation's limit, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Answer;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Ask;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.AskVerdict;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Feed;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Forward;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.ForwardFailed;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Forwarded;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Operation;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Read;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Refused;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Reply;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Search;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Sources;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Status;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Supplier;

public final class GoogleBrokerHost implements GoogleBroker {
  public interface CloudReads {
    CloudRequests.Outcome read(String target);
  }

  private record Exchange(int status, String body) {}

  private record Fetched(Forward forward, Object value, String body) {
    boolean answered() { return forward instanceof Forwarded f && f.status() >= 200 && f.status() < 300; }
    boolean ok() { return answered() && value != null; }
    Fetched failure() { return answered() ? unreadable() : this; }
  }

  private static final int WORKERS = 4, BACKLOG = 8, SOCKET_TIMEOUT_MS = 35_000, HEAD_LIMIT = 8192, DRAIN_LIMIT = 65_536;
  private static final byte[] LOOPBACK = {127, 0, 0, 1};
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final String CALENDAR_READ = "google.calendar.read";
  private static final List<String> READABLE_ROLES = List.of("reader", "writer", "owner");

  private final CloudReads cloud;
  private final ExecutorService workers = Executors.newFixedThreadPool(WORKERS, task -> {
    Thread thread = new Thread(task, "ElizaGoogleBroker");
    thread.setDaemon(true);
    return thread;
  });
  private ServerSocket server;
  private Endpoint endpoint;

  public GoogleBrokerHost(CloudReads cloud) { this.cloud = cloud; }

  public static GoogleBrokerHost overDevice(String apiOrigin, Supplier<CloudRequests.Custody> custody, File cacheDirectory) {
    CloudRequests requests = new CloudRequests(new CloudRequestPolicy(GoogleBrokerPolicy.ROUTE_TABLE), new LargeBodyGrant(cacheDirectory));
    return new GoogleBrokerHost(target -> requests.send(apiOrigin, custody.get(), "GET", target, Map.of("Accept", "application/json"), null));
  }

  @Override public synchronized Endpoint open() throws IOException {
    if (server != null && !server.isClosed()) return endpoint;
    ServerSocket bound = new ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK));
    byte[] secret = new byte[48];
    RANDOM.nextBytes(secret);
    Endpoint opened = new Endpoint(bound.getLocalPort(), Base64.getUrlEncoder().withoutPadding().encodeToString(secret));
    server = bound;
    endpoint = opened;
    Thread accepting = new Thread(() -> accept(bound, opened), "ElizaGoogleBrokerAccept");
    accepting.setDaemon(true);
    accepting.start();
    return opened;
  }

  public synchronized void close() throws IOException {
    if (server != null) server.close();
    server = null;
    endpoint = null;
  }

  private void accept(ServerSocket bound, Endpoint opened) {
    while (!bound.isClosed()) {
      Socket socket;
      try { socket = bound.accept(); }
      catch (IOException closed) { return; }
      try { workers.execute(() -> answer(socket, opened)); }
      catch (RejectedExecutionException busy) { quietly(socket); }
    }
  }

  private void answer(Socket socket, Endpoint opened) {
    try (socket) {
      socket.setSoTimeout(SOCKET_TIMEOUT_MS);
      InputStream in = socket.getInputStream();
      Exchange reply = exchange(in, opened);
      byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
      OutputStream out = socket.getOutputStream();
      out.write(("HTTP/1.1 " + reply.status() + " " + (reply.status() < 300 ? "OK" : "Refused") + "\r\nContent-Type: application/json\r\n"
        + "Cache-Control: no-store\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      out.write(body);
      out.flush();
      socket.shutdownOutput();
      drain(in);
    } catch (IOException | RuntimeException dropped) {
      quietly(socket);
    }
  }

  private Exchange exchange(InputStream in, Endpoint opened) throws IOException {
    String head = head(in);
    if (head == null) return refusal(400, "malformed-request");
    String[] lines = head.split("\r\n", -1);
    String[] start = lines[0].split(" ", -1);
    if (start.length != 3 || !start[2].startsWith("HTTP/1.")) return refusal(400, "malformed-request");
    Map<String, String> headers = new LinkedHashMap<>();
    for (int at = 1; at < lines.length; at++) {
      int colon = lines[at].indexOf(':');
      if (colon <= 0 || headers.put(lines[at].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[at].substring(colon + 1).trim()) != null)
        return refusal(400, "malformed-request");
    }
    if (headers.containsKey("transfer-encoding")) return refusal(400, "malformed-request");
    long length;
    try { length = Long.parseLong(headers.getOrDefault("content-length", "0")); }
    catch (NumberFormatException malformed) { return refusal(400, "malformed-request"); }
    if (length < 0) return refusal(400, "malformed-request");
    String presented = headers.getOrDefault("authorization", "");
    Ask ask = new Ask("POST".equals(start[0]), GoogleBrokerPolicy.PATH.equals(start[1]), ("127.0.0.1:" + opened.port()).equals(headers.get("host")),
      headers.containsKey("origin"), MessageDigest.isEqual(("Bearer " + opened.bearer()).getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8)), length);
    AskVerdict verdict = GoogleBrokerPolicy.askVerdict(ask);
    switch (verdict) {
      case NOT_PRIVATE -> { return refusal(403, "private-agent-request-required"); }
      case NOT_AUTHORIZED -> { return refusal(401, "agent-authentication-required"); }
      case ASK_TOO_LARGE -> { return refusal(413, "request-too-large"); }
      case ASK_ADMITTED -> { }
    }
    byte[] body = in.readNBytes((int) length);
    if (body.length != length) return refusal(400, "malformed-request");
    Operation op = GoogleBrokerPolicy.operationOf(new String(body, StandardCharsets.UTF_8));
    if (!GoogleBrokerPolicy.admits(op)) return replied(op, new ForwardFailed(), "");
    Fetched fetched = perform(op);
    return replied(op, fetched.forward(), fetched.body());
  }

  private static Exchange replied(Operation op, Forward forward, String body) {
    Reply reply = GoogleBrokerPolicy.replyOf(op, forward);
    return switch (reply) {
      case Answer answer -> new Exchange(answer.status(), body);
      case Refused refused -> refusal(refused.status(), refused.reason().wire);
    };
  }

  private static Exchange refusal(int status, String reason) {
    return new Exchange(status, CredentialJson.write(Map.of("reason", reason)));
  }

  private Fetched perform(Operation op) {
    return switch (op) {
      case Status s -> fetch(GoogleBrokerPolicy.target(Read.MAIL_STATUS, "side", "owner"));
      case Search s -> fetch(GoogleBrokerPolicy.target(Read.MAIL_SEARCH, "side", "owner", "grantId", s.grantId(), "query", s.query(),
        "maxResults", String.valueOf(s.maxResults())));
      case Sources s -> sources();
      case Feed f -> feed(f);
      case GoogleBrokerPolicy.Other o -> new Fetched(new ForwardFailed(), null, "");
    };
  }

  private Fetched fetch(String target) {
    return switch (cloud.read(target)) {
      case CloudRequests.Answered answered when answered.grant() == null && answered.body() != null -> {
        String body = new String(answered.body(), StandardCharsets.UTF_8);
        yield new Fetched(new Forwarded(answered.status(), answered.body().length), parsed(body), body);
      }
      case CloudRequests.Answered answered -> new Fetched(new Forwarded(answered.status(), answered.grant() == null ? 0 : answered.grant().size()), null, "");
      case CloudRequests.Failed failed -> new Fetched(new ForwardFailed(), null, "");
    };
  }

  private Fetched sources() {
    Fetched accounts = fetch(GoogleBrokerPolicy.target(Read.CALENDAR_ACCOUNTS, "side", "owner"));
    if (!accounts.ok()) return accounts.failure();
    List<Object> rows = new ArrayList<>();
    for (Map<String, Object> account : calendarAccounts(accounts.value())) {
      String connectionId = (String) account.get("connectionId");
      Fetched calendars = fetch(GoogleBrokerPolicy.target(Read.CALENDAR_LIST, "side", "owner", "grantId", connectionId));
      if (!calendars.ok()) return calendars.failure();
      if (!(calendars.value() instanceof List<?> listed)) return unreadable();
      String scoped = GoogleBrokerPolicy.scopedGrant(connectionId);
      for (Object item : listed) {
        if (!(item instanceof Map<?, ?> row) || !(row.get("calendarId") instanceof String calendarId) || calendarId.isEmpty()
            || !(row.get("label") instanceof String label) || !(row.get("accessRole") instanceof String role)) return unreadable();
        if (!Boolean.TRUE.equals(row.get("read")) || !READABLE_ROLES.contains(role)) continue;
        Map<String, Object> source = ordered("provider", "google", "side", "owner", "grantId", scoped, "connectorAccountId", scoped,
          "calendarId", calendarId, "summary", label, "accessRole", role);
        source.put("accountEmail", row.get("accountEmail") instanceof String email ? email : null);
        source.put("managedGoogleConnectionId", connectionId);
        rows.add(source);
      }
    }
    return shaped(Map.of("calendars", rows));
  }

  private Fetched feed(Feed f) {
    Fetched accounts = fetch(GoogleBrokerPolicy.target(Read.CALENDAR_ACCOUNTS, "side", "owner"));
    if (!accounts.ok()) return accounts.failure();
    String connectionId = null;
    for (Map<String, Object> account : calendarAccounts(accounts.value()))
      if (GoogleBrokerPolicy.scopedGrant((String) account.get("connectionId")).equals(f.grantId())) connectionId = (String) account.get("connectionId");
    if (connectionId == null) {
      String body = CredentialJson.write(Map.of("error", "grant_not_current"));
      return new Fetched(new Forwarded(404, body.length()), null, body);
    }
    Fetched read = fetch(GoogleBrokerPolicy.target(Read.CALENDAR_FEED, "side", "owner", "grantId", connectionId, "calendarId", f.calendarId(),
      "timeMin", f.timeMin(), "timeMax", f.timeMax(), "timeZone", f.timeZone()));
    if (!read.ok()) return read.failure();
    if (!(read.value() instanceof Map<?, ?> answer) || !f.calendarId().equals(answer.get("calendarId")) || !(answer.get("syncedAt") instanceof String syncedAt)
        || !(answer.get("events") instanceof List<?> cards)) return unreadable();
    List<Object> events = new ArrayList<>();
    for (Object card : cards) {
      if (!(card instanceof Map<?, ?> fields) || !(fields.get("externalId") instanceof String externalId) || externalId.isEmpty()) return unreadable();
      Map<String, Object> event = new LinkedHashMap<>();
      for (Map.Entry<?, ?> field : fields.entrySet()) event.put((String) field.getKey(), field.getValue());
      event.put("id", f.grantId() + ":" + externalId);
      event.put("provider", "google");
      event.put("side", "owner");
      event.put("grantId", f.grantId());
      event.put("connectorAccountId", f.grantId());
      event.put("syncedAt", syncedAt);
      if (fields.get("seriesId") instanceof String series) event.put("recurringEventId", series);
      events.add(event);
    }
    Map<String, Object> key = ordered("provider", "google", "side", "owner", "grantId", f.grantId(), "connectorAccountId", f.grantId(), "calendarId", f.calendarId());
    Map<String, Object> feed = ordered("calendarId", f.calendarId(), "state", "complete", "source", "synced", "timeMin", f.timeMin(), "timeMax", f.timeMax(),
      "syncedAt", syncedAt);
    feed.put("events", events);
    feed.put("sources", List.of(ordered("key", key, "status", "fresh", "syncedAt", syncedAt)));
    return shaped(Map.of("feed", feed));
  }

  private static List<Map<String, Object>> calendarAccounts(Object value) {
    List<Map<String, Object>> found = new ArrayList<>();
    if (!(value instanceof List<?> accounts)) return found;
    for (Object item : accounts)
      if (item instanceof Map<?, ?> account && Boolean.TRUE.equals(account.get("connected")) && account.get("connectionId") instanceof String id && !id.isEmpty()
          && account.get("grantedCapabilities") instanceof List<?> capabilities && capabilities.contains(CALENDAR_READ))
        found.add(CredentialJson.object(account, "account"));
    return found;
  }

  private static Fetched shaped(Object value) {
    String body = CredentialJson.write(value);
    return new Fetched(new Forwarded(200, body.getBytes(StandardCharsets.UTF_8).length), value, body);
  }

  private static Fetched unreadable() { return new Fetched(new ForwardFailed(), null, ""); }

  private static Object parsed(String body) {
    try { return CredentialJson.parse(body); }
    catch (IllegalArgumentException malformed) { return null; }
  }

  private static Map<String, Object> ordered(Object... pairs) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int at = 0; at < pairs.length; at += 2) map.put((String) pairs[at], pairs[at + 1]);
    return map;
  }

  private static String head(InputStream in) throws IOException {
    ByteArrayOutputStream read = new ByteArrayOutputStream();
    int matched = 0;
    while (read.size() < HEAD_LIMIT) {
      int next = in.read();
      if (next < 0) return null;
      read.write(next);
      matched = next == (matched % 2 == 0 ? '\r' : '\n') ? matched + 1 : next == '\r' ? 1 : 0;
      if (matched == 4) {
        String text = read.toString(StandardCharsets.ISO_8859_1);
        return text.substring(0, text.length() - 4);
      }
    }
    return null;
  }

  private static void drain(InputStream in) throws IOException {
    byte[] unread = new byte[HEAD_LIMIT];
    for (long drained = 0; drained < DRAIN_LIMIT; ) {
      int count = in.read(unread);
      if (count < 0) return;
      drained += count;
    }
  }

  private static void quietly(Socket socket) {
    try { socket.close(); }
    catch (IOException ignored) { }
  }
}
