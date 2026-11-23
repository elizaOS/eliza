// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail and calendar without holding a mail credential"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

public final class GoogleBrokerJourney {
  private static final Account ACCOUNT = new Account("user-1", "org-1");
  private static final String KEY = "eliza_mobile_fixture_key";
  private static final String CALENDAR_GRANT = "11111111-2222-4333-8444-555555555555";
  private static final String MAIL_GRANT = "66666666-7777-4888-9999-000000000000";
  private static final long NOW = 1_795_000_000_000L;

  private record Seen(String target, String authorization) {}
  private record Reply(int status, String body) {}

  private static final class FakeCloud {
    final List<Seen> seen = new CopyOnWriteArrayList<>();
    final HttpServer server;

    FakeCloud() throws IOException {
      server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
      server.createContext("/", this::handle);
      server.start();
    }

    String origin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private void handle(HttpExchange exchange) throws IOException {
      URI uri = exchange.getRequestURI();
      seen.add(new Seen(exchange.getRequestMethod() + " " + uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()),
        exchange.getRequestHeaders().getFirst("Authorization")));
      Map<String, String> query = new HashMap<>();
      if (uri.getRawQuery() != null)
        for (String pair : uri.getRawQuery().split("&")) {
          int at = pair.indexOf('=');
          query.put(URLDecoder.decode(pair.substring(0, at), StandardCharsets.UTF_8), URLDecoder.decode(pair.substring(at + 1), StandardCharsets.UTF_8));
        }
      Object body = switch (uri.getRawPath()) {
        case "/api/v1/eliza/google/status" -> connection(CALENDAR_GRANT, true, List.of("google.basic_identity", "google.gmail.triage", "google.calendar.read"));
        case "/api/v1/eliza/google/accounts" -> List.of(connection(CALENDAR_GRANT, true, List.of("google.basic_identity", "google.calendar.read")),
          connection(MAIL_GRANT, true, List.of("google.basic_identity", "google.gmail.triage")),
          connection("99999999-8888-4777-8666-555555555555", false, List.of()));
        case "/api/v1/eliza/google/gmail/search" -> "huge".equals(query.get("query"))
          ? Map.of("messages", List.of(), "padding", "x".repeat(300_000))
          : ordered("messages", List.of(), "nextPageToken", null, "syncedAt", "2026-11-20T10:00:00.000Z", "mailboxHistoryId", "41", "supportsSpamTrash", true);
        case "/api/v1/eliza/google/calendar/calendars" -> List.of(
          ordered("calendarId", "primary@example.com", "accountId", "sub-1", "accountEmail", "ana@example.com", "label", "Ana", "accessRole", "owner", "read", true, "write", false),
          ordered("calendarId", "busy@example.com", "accountId", "sub-1", "accountEmail", "ana@example.com", "label", "Busy", "accessRole", "freeBusyReader", "read", false, "write", false));
        case "/api/v1/eliza/google/calendar/feed" -> ordered("calendarId", query.get("calendarId"), "syncedAt", "2026-11-20T10:00:00.000Z", "events", List.of(
          ordered("externalId", "ev1", "calendarId", query.get("calendarId"), "title", "Lunch", "description", "", "location", "", "status", "confirmed",
            "startAt", "2026-11-21T12:00:00.000Z", "endAt", "2026-11-21T13:00:00.000Z", "isAllDay", false, "timezone", "UTC", "htmlLink", null,
            "conferenceLink", null, "etag", "\"1\"", "seriesId", "series-1", "organizer", null, "attendees", List.of(),
            "metadata", ordered("iCalUID", null, "createdAt", null, "updatedAt", "2026-11-20T09:00:00.000Z"))));
        default -> null;
      };
      byte[] bytes = (body == null ? "{\"error\":\"not_found\"}" : CredentialJson.write(body)).getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(body == null ? 404 : 200, bytes.length);
      try (OutputStream out = exchange.getResponseBody()) { out.write(bytes); }
    }
  }

  private GoogleBrokerJourney() {}

  private static Map<String, Object> connection(String id, boolean connected, List<String> capabilities) {
    return ordered("provider", "google", "side", "owner", "configured", true, "connected", connected, "reason", connected ? "connected" : "disconnected",
      "identity", ordered("id", "sub-1", "email", "ana@example.com", "name", null), "grantedCapabilities", capabilities, "connectionId", id);
  }

  private static Map<String, Object> ordered(Object... pairs) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int at = 0; at < pairs.length; at += 2) map.put((String) pairs[at], pairs[at + 1]);
    return map;
  }

  private static final class MemorySlots implements DeviceCredentialStore.Slots {
    final Map<String, String> slots = new HashMap<>();
    @Override public String read(String slot) { return slots.get(slot); }
    @Override public void write(String slot, String value) { slots.put(slot, value); }
    @Override public void remove(String slot) { slots.remove(slot); }
  }

  private static CloudRequests.Custody custody(String origin, boolean signedIn) {
    DeviceCredentialStore store = new DeviceCredentialStore(new MemorySlots(), DeviceCredentialStore.authorityDigest(origin), () -> NOW);
    if (signedIn) {
      int attempt = store.beginSignIn();
      long expiry = NOW + 86_400_000L;
      if (store.tokenAnswered(attempt, new DeviceCredentialStore.Token("active", KEY, ACCOUNT, expiry)) != DeviceCredentialStore.Kept.KEPT
          || store.acknowledged(attempt, "active", expiry) != DeviceCredentialStore.Outcome.ACCEPTED)
        throw new IllegalStateException("The device credential fixture did not commit");
    }
    return new CloudRequests.Custody(store, new AccountSession(store, new DeviceKeyClient(URI.create(origin), store, ms -> {})));
  }

  private static Reply call(GoogleBroker.Endpoint endpoint, String method, String path, String host, String extra, String bearer, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), endpoint.port())) {
      socket.setSoTimeout(20_000);
      OutputStream out = socket.getOutputStream();
      out.write((method + " " + path + " HTTP/1.1\r\nHost: " + host + "\r\n" + extra + (bearer == null ? "" : "Authorization: Bearer " + bearer + "\r\n")
        + "Content-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      out.write(bytes);
      out.flush();
      InputStream in = socket.getInputStream();
      ByteArrayOutputStream all = new ByteArrayOutputStream();
      in.transferTo(all);
      String text = all.toString(StandardCharsets.UTF_8);
      int split = text.indexOf("\r\n\r\n");
      return new Reply(Integer.parseInt(text.substring(9, 12)), text.substring(split + 4));
    }
  }

  private static Reply agent(GoogleBroker.Endpoint endpoint, String body) throws IOException {
    return call(endpoint, "POST", GoogleBrokerPolicy.PATH, "127.0.0.1:" + endpoint.port(), "", endpoint.bearer(), body);
  }

  private static String summary(Reply reply) { return reply.status() + " " + reply.body(); }

  public static void main(String[] args) throws Exception {
    FakeCloud cloud = new FakeCloud();
    Path cache = Files.createTempDirectory("google-broker-");
    GoogleBrokerHost host = GoogleBrokerHost.overDevice(cloud.origin(), () -> custody(cloud.origin(), true), cache.toFile());
    Map<String, Object> seen = new LinkedHashMap<>();
    try {
      GoogleBroker.Endpoint endpoint = host.open();
      String status = "{\"gmail\":{\"operation\":\"status\"}}";
      seen.put("sameEndpointOnReopen", host.open().equals(endpoint));
      seen.put("endpointHidesBearer", !endpoint.toString().contains(endpoint.bearer()));
      seen.put("environment", new ArrayList<>(new java.util.TreeMap<>(endpoint.environment()).keySet()));
      seen.put("environmentUrl", endpoint.environment().get("ELIZA_MANAGED_GMAIL_READ_BROKER").equals("http://127.0.0.1:" + endpoint.port() + "/__alpha-owner-gmail"));

      Map<String, Object> refusals = new LinkedHashMap<>();
      refusals.put("wrongBearer", call(endpoint, "POST", GoogleBrokerPolicy.PATH, "127.0.0.1:" + endpoint.port(), "", "x".repeat(64), status).status());
      refusals.put("noBearer", call(endpoint, "POST", GoogleBrokerPolicy.PATH, "127.0.0.1:" + endpoint.port(), "", null, status).status());
      refusals.put("withOrigin", call(endpoint, "POST", GoogleBrokerPolicy.PATH, "127.0.0.1:" + endpoint.port(), "Origin: https://evil.test\r\n", endpoint.bearer(), status).status());
      refusals.put("wrongHost", call(endpoint, "POST", GoogleBrokerPolicy.PATH, "localhost:" + endpoint.port(), "", endpoint.bearer(), status).status());
      refusals.put("wrongPath", call(endpoint, "POST", "/", "127.0.0.1:" + endpoint.port(), "", endpoint.bearer(), status).status());
      refusals.put("get", call(endpoint, "GET", GoogleBrokerPolicy.PATH, "127.0.0.1:" + endpoint.port(), "", endpoint.bearer(), "").status());
      refusals.put("tooLarge", agent(endpoint, "{\"gmail\":{\"operation\":\"status\",\"pad\":\"" + "x".repeat(8200) + "\"}}").status());
      seen.put("refusals", refusals);
      seen.put("cloudCallsAfterRefusals", cloud.seen.size());

      Map<String, Object> unlisted = new LinkedHashMap<>();
      unlisted.put("searchOf30", summary(agent(endpoint, "{\"gmail\":{\"operation\":\"search\",\"grantId\":\"" + MAIL_GRANT + "\",\"query\":\"in:inbox\",\"maxResults\":30}}")));
      unlisted.put("emptyQuery", agent(endpoint, "{\"gmail\":{\"operation\":\"search\",\"grantId\":\"" + MAIL_GRANT + "\",\"query\":\"\",\"maxResults\":25}}").status());
      unlisted.put("messageRead", agent(endpoint, "{\"gmail\":{\"operation\":\"read\",\"grantId\":\"" + MAIL_GRANT + "\",\"messageId\":\"m1\"}}").status());
      unlisted.put("send", agent(endpoint, "{\"send\":{\"operation\":\"prepare\",\"to\":\"a@b.c\",\"subject\":\"s\",\"bodyText\":\"b\",\"requestId\":\"r\"}}").status());
      unlisted.put("mailbox", agent(endpoint, "{\"mailbox\":{\"kind\":\"trash\",\"messageId\":\"m1\",\"requestId\":\"r\"}}").status());
      unlisted.put("calendarWrite", agent(endpoint, "{\"calendar\":{\"operation\":\"write-capabilities\",\"grantId\":\"g\",\"calendarId\":\"c\"}}").status());
      unlisted.put("extraField", agent(endpoint, "{\"gmail\":{\"operation\":\"status\",\"grantId\":\"" + MAIL_GRANT + "\"}}").status());
      unlisted.put("twoOperations", agent(endpoint, "{\"gmail\":{\"operation\":\"status\"},\"calendar\":{\"operation\":\"sources\"}}").status());
      unlisted.put("unscopedFeed", agent(endpoint, "{\"calendar\":{\"operation\":\"feed\",\"grantId\":\"" + CALENDAR_GRANT + "\",\"calendarId\":\"c\",\"timeMin\":\"a\",\"timeMax\":\"b\",\"timeZone\":\"UTC\"}}").status());
      unlisted.put("notJson", agent(endpoint, "status").status());
      seen.put("unlisted", unlisted);
      seen.put("cloudCallsAfterUnlisted", cloud.seen.size());

      Reply mailStatus = agent(endpoint, status);
      seen.put("statusReply", mailStatus.status());
      seen.put("statusConnectionId", CredentialJson.object(CredentialJson.parse(mailStatus.body()), "status").get("connectionId"));
      Reply search = agent(endpoint, "{\"gmail\":{\"operation\":\"search\",\"grantId\":\"" + MAIL_GRANT + "\",\"query\":\"from:bo in:inbox\",\"maxResults\":25}}");
      seen.put("searchReply", search.status());
      seen.put("searchHistory", CredentialJson.object(CredentialJson.parse(search.body()), "search").get("mailboxHistoryId"));
      seen.put("oversizeSearch", summary(agent(endpoint, "{\"gmail\":{\"operation\":\"search\",\"grantId\":\"" + MAIL_GRANT + "\",\"query\":\"huge\",\"maxResults\":10}}")));

      Reply sources = agent(endpoint, "{\"calendar\":{\"operation\":\"sources\"}}");
      seen.put("sourcesReply", sources.status());
      seen.put("sources", CredentialJson.parse(sources.body()));
      String scoped = GoogleBrokerPolicy.scopedGrant(CALENDAR_GRANT);
      Reply feed = agent(endpoint, "{\"calendar\":{\"operation\":\"feed\",\"grantId\":\"" + scoped + "\",\"calendarId\":\"primary@example.com\","
        + "\"timeMin\":\"2026-11-21T00:00:00.000Z\",\"timeMax\":\"2026-11-22T00:00:00.000Z\",\"timeZone\":\"UTC\"}}");
      seen.put("feedReply", feed.status());
      seen.put("feed", CredentialJson.parse(feed.body()));
      seen.put("staleGrantFeed", agent(endpoint, "{\"calendar\":{\"operation\":\"feed\",\"grantId\":\"" + GoogleBrokerPolicy.scopedGrant(MAIL_GRANT)
        + "\",\"calendarId\":\"primary@example.com\",\"timeMin\":\"2026-11-21T00:00:00.000Z\",\"timeMax\":\"2026-11-22T00:00:00.000Z\",\"timeZone\":\"UTC\"}}").status());

      List<Object> targets = new ArrayList<>();
      boolean everyCallCarriedTheDeviceCredential = true;
      for (Seen call : cloud.seen) {
        targets.add(call.target());
        everyCallCarriedTheDeviceCredential &= ("Bearer " + KEY).equals(call.authorization());
      }
      seen.put("cloudTargets", targets);
      seen.put("everyCallCarriedTheDeviceCredential", everyCallCarriedTheDeviceCredential);
      seen.put("noReplyShowedTheCredential", !(mailStatus.body() + search.body() + sources.body() + feed.body()).contains(KEY));

      GoogleBrokerHost signedOut = GoogleBrokerHost.overDevice(cloud.origin(), () -> custody(cloud.origin(), false), cache.toFile());
      try {
        GoogleBroker.Endpoint other = signedOut.open();
        int before = cloud.seen.size();
        seen.put("signedOutStatus", summary(agent(other, status)));
        seen.put("signedOutCloudCalls", cloud.seen.size() - before);
        seen.put("otherBearerRefused", call(other, "POST", GoogleBrokerPolicy.PATH, "127.0.0.1:" + other.port(), "", endpoint.bearer(), status).status());
      } finally {
        signedOut.close();
      }
      host.close();
      boolean closed;
      try { agent(endpoint, status); closed = false; }
      catch (IOException refused) { closed = true; }
      seen.put("closedRefusesConnections", closed);
    } finally {
      host.close();
      cloud.server.stop(0);
    }
    System.out.println(CredentialJson.write(seen));
  }
}
