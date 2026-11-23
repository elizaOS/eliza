// spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a POST to its private path on the loopback host, without an origin, with its bearer and at most 8 KiB"; spec/os/signIn/cloudRequests.md, "The broker reads only Gmail status and search, and the calendar list and feed, each through listed GET routes"; spec/os/signIn/cloudRequests.md, "Each read carries the credential the plan names for its route, and never a session or nothing"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body within the operation's limit, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.RouteGate.Method;
import ai.eliza.plugins.signin.CloudRequestPolicy.CallPlan;
import ai.eliza.plugins.signin.CloudRequestPolicy.DeviceRoute;
import ai.eliza.plugins.signin.CloudRequestPolicy.Holding;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refuse;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.StringJoiner;
import java.util.regex.Pattern;

public final class GoogleBrokerPolicy {
  public static final String PATH = "/__alpha-owner-gmail";
  public static final long ASK_LIMIT = 8192L;
  public static final long REPLY_LIMIT = 262_144L;
  public static final long FEED_REPLY_LIMIT = 524_288L;
  public static final List<Integer> SEARCH_SIZES = List.of(10, 25, 50);
  public static final int QUERY_LIMIT = 4096, GRANT_LIMIT = 256, FIELD_LIMIT = 1024;
  public static final Pattern BEARER = Pattern.compile("[A-Za-z0-9_-]{64}");
  public static final Pattern SCOPED_GRANT = Pattern.compile("alpha-google:[a-f0-9]{64}");
  public static final String ROUTE_TABLE = routeTable();

  private static final String GOOGLE = "/api/v1/eliza/google";

  public record Ask(boolean post, boolean privatePath, boolean loopbackHost, boolean origin, boolean bearer, long bytes) {}

  public enum AskVerdict { ASK_ADMITTED, NOT_PRIVATE, NOT_AUTHORIZED, ASK_TOO_LARGE }

  public enum Read {
    MAIL_STATUS("status"), MAIL_SEARCH("gmail", "search"), CALENDAR_ACCOUNTS("accounts"), CALENDAR_LIST("calendar", "calendars"), CALENDAR_FEED("calendar", "feed");

    private final List<String> path;

    Read(String... names) {
      List<String> full = new ArrayList<>(List.of("api", "v1", "eliza", "google"));
      full.addAll(List.of(names));
      path = List.copyOf(full);
    }

    public List<String> path() { return path; }
  }

  public sealed interface Operation permits Status, Search, Sources, Feed, Other {}
  public record Status() implements Operation {}
  public record Search(String grantId, String query, int maxResults) implements Operation {
    @Override public String toString() { return "Search[" + maxResults + "]"; }
  }
  public record Sources() implements Operation {}
  public record Feed(String grantId, String calendarId, String timeMin, String timeMax, String timeZone) implements Operation {
    public boolean scoped() { return SCOPED_GRANT.matcher(grantId).matches(); }
    public int fieldUnits() {
      int widest = 0;
      for (String field : List.of(calendarId, timeMin, timeMax, timeZone)) {
        if (field.isEmpty()) return 0;
        widest = Math.max(widest, field.length());
      }
      return widest;
    }
    @Override public String toString() { return "Feed[" + calendarId.length() + "]"; }
  }
  public record Other() implements Operation {}

  public sealed interface Forward permits Forwarded, ForwardFailed {}
  public record Forwarded(int status, long bytes) implements Forward {}
  public record ForwardFailed() implements Forward {}

  public enum Reason {
    OPERATION_REFUSED("operation-refused"), BROKER_REPLY_TOO_LARGE("reply-too-large"), CLOUD_UNREACHABLE("cloud-unreachable");

    public final String wire;

    Reason(String wire) { this.wire = wire; }
  }

  public sealed interface Reply permits Answer, Refused {}
  public record Answer(int status, long bytes) implements Reply {}
  public record Refused(int status, Reason reason) implements Reply {}

  private GoogleBrokerPolicy() {}

  public static AskVerdict askVerdict(Ask ask) {
    if (!ask.post() || !ask.privatePath() || !ask.loopbackHost() || ask.origin()) return AskVerdict.NOT_PRIVATE;
    if (!ask.bearer()) return AskVerdict.NOT_AUTHORIZED;
    return ask.bytes() > ASK_LIMIT ? AskVerdict.ASK_TOO_LARGE : AskVerdict.ASK_ADMITTED;
  }

  public static List<Read> reads(Operation op) {
    return switch (op) {
      case Status s -> List.of(Read.MAIL_STATUS);
      case Search s -> SEARCH_SIZES.contains(s.maxResults()) && within(s.query(), QUERY_LIMIT) && within(s.grantId(), GRANT_LIMIT)
        ? List.of(Read.MAIL_SEARCH) : List.of();
      case Sources s -> List.of(Read.CALENDAR_ACCOUNTS, Read.CALENDAR_LIST);
      case Feed f -> f.scoped() && f.fieldUnits() >= 1 && f.fieldUnits() <= FIELD_LIMIT ? List.of(Read.CALENDAR_ACCOUNTS, Read.CALENDAR_FEED) : List.of();
      case Other o -> List.of();
    };
  }

  public static boolean admits(Operation op) { return !reads(op).isEmpty(); }

  public static DeviceRoute routeOf(Read read) {
    for (DeviceRoute d : CloudRequestPolicy.DEVICE_ROUTES) if (d.method() == Method.GET && d.path().equals(read.path())) return d;
    return null;
  }

  public static boolean listedGet(Read read) { return routeOf(read) != null; }

  public static CallPlan plan(Holding h, Read read) {
    DeviceRoute d = routeOf(read);
    return d == null ? new Refuse(CloudRequestPolicy.Refusal.NOT_LISTED) : CloudRequestPolicy.attachFor(h, d.auth());
  }

  public static long replyLimit(Operation op) { return op instanceof Feed ? FEED_REPLY_LIMIT : REPLY_LIMIT; }

  public static Reply replyOf(Operation op, Forward forward) {
    if (!admits(op)) return new Refused(409, Reason.OPERATION_REFUSED);
    return switch (forward) {
      case Forwarded f -> f.bytes() > replyLimit(op) ? new Refused(502, Reason.BROKER_REPLY_TOO_LARGE) : new Answer(f.status(), f.bytes());
      case ForwardFailed f -> new Refused(503, Reason.CLOUD_UNREACHABLE);
    };
  }

  public static Operation operationOf(String body) {
    Object parsed;
    try { parsed = CredentialJson.parse(body); }
    catch (IllegalArgumentException malformed) { return new Other(); }
    if (!(parsed instanceof Map<?, ?> request) || request.size() != 1) return new Other();
    if (request.get("gmail") instanceof Map<?, ?> gmail) {
      if (exactly(gmail, Set.of("operation")) && "status".equals(gmail.get("operation"))) return new Status();
      if (exactly(gmail, Set.of("operation", "grantId", "query", "maxResults")) && "search".equals(gmail.get("operation"))
          && gmail.get("grantId") instanceof String grantId && gmail.get("query") instanceof String query && gmail.get("maxResults") instanceof Long size
          && size <= Integer.MAX_VALUE)
        return new Search(grantId, query, (int) (long) size);
    }
    if (request.get("calendar") instanceof Map<?, ?> calendar) {
      if (exactly(calendar, Set.of("operation")) && "sources".equals(calendar.get("operation"))) return new Sources();
      if (exactly(calendar, Set.of("operation", "grantId", "calendarId", "timeMin", "timeMax", "timeZone")) && "feed".equals(calendar.get("operation"))
          && calendar.get("grantId") instanceof String grantId && calendar.get("calendarId") instanceof String calendarId
          && calendar.get("timeMin") instanceof String timeMin && calendar.get("timeMax") instanceof String timeMax && calendar.get("timeZone") instanceof String timeZone)
        return new Feed(grantId, calendarId, timeMin, timeMax, timeZone);
    }
    return new Other();
  }

  public static String target(Read read, String... pairs) {
    StringJoiner query = new StringJoiner("&");
    for (int at = 0; at + 1 < pairs.length; at += 2) query.add(encode(pairs[at]) + "=" + encode(pairs[at + 1]));
    return "/" + String.join("/", read.path()) + (pairs.length == 0 ? "" : "?" + query);
  }

  public static String scopedGrant(String connectionId) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(("alpha-google\n" + connectionId).getBytes(StandardCharsets.UTF_8));
      return "alpha-google:" + HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException missing) {
      throw new IllegalStateException("SHA-256 is unavailable", missing);
    }
  }

  private static boolean within(String text, int limit) { return !text.isEmpty() && text.length() <= limit; }

  private static boolean exactly(Map<?, ?> fields, Set<String> names) { return fields.keySet().equals(names); }

  private static String encode(String text) { return URLEncoder.encode(text, StandardCharsets.UTF_8).replace("+", "%20"); }

  private static String routeTable() {
    String owner = "{\"key\":\"side\",\"accepts\":{\"kind\":\"pinned\",\"value\":\"owner\"}}";
    String any = "{\"kind\":\"any\"}";
    return "[{\"prefixes\":[\"" + GOOGLE + "\"],\"routes\":["
      + "{\"method\":\"GET\",\"path\":\"" + GOOGLE + "/status\",\"query\":[" + owner + "]},"
      + "{\"method\":\"GET\",\"path\":\"" + GOOGLE + "/accounts\",\"query\":[" + owner + "]},"
      + "{\"method\":\"GET\",\"path\":\"" + GOOGLE + "/gmail/search\",\"query\":[" + owner + ",{\"key\":\"grantId\",\"accepts\":" + any + "},"
      + "{\"key\":\"query\",\"accepts\":" + any + "},{\"key\":\"maxResults\",\"accepts\":{\"kind\":\"pattern\",\"pattern\":\"10|25|50\"}}]},"
      + "{\"method\":\"GET\",\"path\":\"" + GOOGLE + "/calendar/calendars\",\"query\":[" + owner + ",{\"key\":\"grantId\",\"accepts\":" + any + "}]},"
      + "{\"method\":\"GET\",\"path\":\"" + GOOGLE + "/calendar/feed\",\"query\":[" + owner + ",{\"key\":\"grantId\",\"accepts\":" + any + "},"
      + "{\"key\":\"calendarId\",\"accepts\":" + any + "},{\"key\":\"timeMin\",\"accepts\":" + any + "},{\"key\":\"timeMax\",\"accepts\":" + any + "},"
      + "{\"key\":\"timeZone\",\"accepts\":" + any + "}]}]}]";
  }
}
