// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/agent/access/routes.md, "The first matching route of the claiming group admits a request, or finds its body too large"; spec/cloud/client.md, "A device sends only the routes of one table, each with its own headers"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.RouteGate;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CloudRequestPolicy {
  public static final long INLINE_LIMIT = 8L << 20;
  public static final long BODY_LIMIT = 64L << 20;
  public static final Set<String> EXTERNAL_HOSTS = Set.of("billing.stripe.com", "checkout.stripe.com", "accounts.google.com");
  public static final String IF_MATCH = "If-Match", IF_NONE_MATCH = "If-None-Match", IDEMPOTENCY_KEY = "Idempotency-Key";

  public enum Auth { PUBLIC, KEY_OR_SESSION, SESSION, FRESH_SESSION, STEP_UP }
  public enum Credential { NONE, DEVICE_KEY, ACCOUNT_SESSION }
  public enum Delivery { INLINE, GRANT, TOO_LARGE }
  public enum Failure { TABLE_REFUSED, UNKNOWN_ENVIRONMENT, ROUTE_REFUSED, TOO_LARGE, SIGNED_OUT, REAUTH_REQUIRED, NETWORK, GRANT_UNKNOWN, HOST_REFUSED }

  public record DeviceRoute(RouteGate.Method method, List<String> path, Auth auth, Set<String> headers) {
    public DeviceRoute { path = List.copyOf(path); headers = Set.copyOf(headers); }
    boolean serves(RouteGate.Route route) {
      if (route.method() != method || route.delivery() != RouteGate.Delivery.BUFFERED || route.path().size() != path.size()) return false;
      for (int at = 0; at < path.size(); at++) {
        RouteGate.Piece piece = route.path().get(at);
        String segment = path.get(at);
        if (piece.isParam() != segment.startsWith(":") || !piece.isParam() && !segment.equals(piece.literal())) return false;
      }
      return true;
    }
    public boolean admitsHeader(String name) { return IF_NONE_MATCH.equals(name) ? method == RouteGate.Method.GET : headers.contains(name); }
  }

  public sealed interface Decision permits Admitted, Refused {}
  public record Admitted(DeviceRoute route, Credential credential, Map<String, String> headers) implements Decision {}
  public record Refused(Failure failure) implements Decision {}

  public static final List<DeviceRoute> DEVICE_ROUTES = deviceRoutes();

  private static final Pattern CREDENTIAL_REASON = Pattern.compile("\"reason\"\\s*:\\s*\"(credential_expired|credential_revoked|credential_unknown)\"");
  private static final Set<String> SIGN_IN_PREFIXES = Set.of("auth", "app-auth");
  private static final Pattern HEADER_VALUE = Pattern.compile("[\\x21-\\x7e]([\\x20-\\x7e]{0,510}[\\x21-\\x7e])?");

  private final RouteGate gate;
  private final Map<RouteGate.Route, DeviceRoute> served;

  private CloudRequestPolicy(RouteGate gate, Map<RouteGate.Route, DeviceRoute> served) {
    this.gate = gate;
    this.served = served;
  }

  public static CloudRequestPolicy load(String consumerTable) {
    RouteGate gate = new RouteGate();
    Map<RouteGate.Route, DeviceRoute> served = new LinkedHashMap<>();
    if (consumerTable != null && gate.loadWire(consumerTable)) {
      for (RouteGate.Group group : gate.served())
        for (RouteGate.Route route : group.routes()) {
          DeviceRoute device = deviceRouteOf(route);
          if (device == null || SIGN_IN_PREFIXES.contains(device.path().get(2))) { gate.load(List.of()); return new CloudRequestPolicy(gate, Map.of()); }
          served.put(route, device);
        }
    }
    return new CloudRequestPolicy(gate, Map.copyOf(served));
  }

  public boolean loaded() { return gate.table() == RouteGate.Table.LOADED; }

  public List<RouteGate.Group> routes() { return gate.served(); }

  public RouteGate.Request request(String method, String target, byte[] body) { return gate.request(method, target, false, body); }

  public Decision admit(String method, String target, Map<String, String> callerHeaders, byte[] body) {
    if (!loaded()) return new Refused(Failure.TABLE_REFUSED);
    RouteGate.Admission admission = gate.admit(request(method, target, body));
    switch (admission.verdict()) {
      case TOO_LARGE: return new Refused(Failure.TOO_LARGE);
      case ROUTE_REFUSED: return new Refused(Failure.ROUTE_REFUSED);
      default: break;
    }
    DeviceRoute device = served.get(admission.route());
    Map<String, String> headers = new LinkedHashMap<>();
    for (Map.Entry<String, String> header : callerHeaders.entrySet()) {
      String name = canonicalHeader(header.getKey());
      if (name == null || !device.admitsHeader(name) || header.getValue() == null || !HEADER_VALUE.matcher(header.getValue()).matches() || headers.containsKey(name))
        return new Refused(Failure.ROUTE_REFUSED);
      headers.put(name, header.getValue());
    }
    return new Admitted(device, credentialFor(device.auth()), Map.copyOf(headers));
  }

  public static Credential credentialFor(Auth auth) {
    return switch (auth) {
      case PUBLIC -> Credential.NONE;
      case KEY_OR_SESSION -> Credential.DEVICE_KEY;
      case SESSION, FRESH_SESSION, STEP_UP -> Credential.ACCOUNT_SESSION;
    };
  }

  public static Delivery deliveryOf(long size) {
    return size > BODY_LIMIT ? Delivery.TOO_LARGE : size > INLINE_LIMIT ? Delivery.GRANT : Delivery.INLINE;
  }

  public static boolean externalHost(String url) {
    URI uri;
    try { uri = new URI(url); }
    catch (Exception malformed) { return false; }
    String host = uri.getHost();
    return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
      && host != null && EXTERNAL_HOSTS.contains(host.toLowerCase(Locale.ROOT));
  }

  public static String credentialReason(String body) {
    if (body == null) return "credential_unknown";
    Matcher reason = CREDENTIAL_REASON.matcher(body);
    return reason.find() ? reason.group(1) : "credential_unknown";
  }

  private static String canonicalHeader(String name) {
    if (name == null) return null;
    return switch (name.toLowerCase(Locale.ROOT)) {
      case "if-match" -> IF_MATCH;
      case "if-none-match" -> IF_NONE_MATCH;
      case "idempotency-key" -> IDEMPOTENCY_KEY;
      default -> null;
    };
  }

  private static DeviceRoute deviceRouteOf(RouteGate.Route route) {
    for (DeviceRoute device : DEVICE_ROUTES) if (device.serves(route)) return device;
    return null;
  }

  private static List<String> api(String... names) {
    List<String> path = new ArrayList<>(List.of("api", "v1"));
    path.addAll(List.of(names));
    return path;
  }

  private static List<String> google(String... names) {
    List<String> path = api("eliza", "google");
    path.addAll(List.of(names));
    return path;
  }

  private static DeviceRoute route(RouteGate.Method method, List<String> path, Auth auth) { return new DeviceRoute(method, path, auth, Set.of()); }

  private static DeviceRoute keyed(RouteGate.Method method, List<String> path, String header) { return new DeviceRoute(method, path, Auth.KEY_OR_SESSION, Set.of(header)); }

  private static List<DeviceRoute> deviceRoutes() {
    RouteGate.Method get = RouteGate.Method.GET, post = RouteGate.Method.POST, patch = RouteGate.Method.PATCH, delete = RouteGate.Method.DELETE;
    Auth pub = Auth.PUBLIC, key = Auth.KEY_OR_SESSION, session = Auth.SESSION, fresh = Auth.FRESH_SESSION, stepUp = Auth.STEP_UP;
    return List.of(
      route(get, List.of("api", "public", "service"), pub),
      route(get, api("auth", "methods"), pub),
      route(post, api("auth", "email", "code", "send"), pub),
      route(post, api("auth", "email", "code", "verify"), pub),
      route(post, api("auth", "sms", "code", "send"), pub),
      route(post, api("auth", "sms", "code", "verify"), pub),
      route(get, api("auth", "google", "authorize"), pub),
      route(post, api("auth", "google", "exchange"), pub),
      route(post, api("auth", "google", "native", "challenge"), pub),
      route(post, api("auth", "mfa", "complete"), pub),
      route(post, api("auth", "mfa", "sms", "send"), pub),
      route(post, api("auth", "refresh"), pub),
      route(post, api("auth", "logout"), session),
      route(post, api("auth", "mfa", "step-up"), session),
      route(get, api("auth", "mfa"), session),
      route(post, api("auth", "mfa", "totp", "enroll"), stepUp),
      route(post, api("auth", "mfa", "totp", "confirm"), stepUp),
      route(post, api("auth", "mfa", "sms", "enroll"), stepUp),
      route(post, api("auth", "mfa", "sms", "confirm"), stepUp),
      route(delete, api("auth", "mfa", ":factorId"), stepUp),
      route(get, api("user", "methods"), session),
      route(post, api("user", "methods", "phone", "code", "send"), session),
      route(post, api("user", "methods", "phone", "code", "verify"), session),
      route(post, api("user", "methods", "google", "challenge"), session),
      route(post, api("user", "methods", "google", "link"), session),
      route(delete, api("user", "methods", ":methodId"), stepUp),
      route(get, api("user"), key),
      route(get, api("referrals"), key),
      route(post, api("referrals", "apply"), key),
      route(get, api("app-auth", "mobile", "config"), pub),
      route(post, api("app-auth", "connect"), session),
      route(post, api("app-auth", "mobile", "token"), pub),
      route(post, api("app-auth", "mobile", "ack"), pub),
      route(post, api("app-auth", "mobile", "google"), pub),
      route(delete, api("api-keys", "current"), key),
      route(get, api("subscriptions", "plans"), pub),
      route(get, api("subscription", "entitlement-keys"), pub),
      route(get, api("billing", "limits"), key),
      route(get, api("subscription", "entitlement"), key),
      keyed(post, api("subscription", "redeem"), IDEMPOTENCY_KEY),
      keyed(post, api("subscriptions", "checkout"), IDEMPOTENCY_KEY),
      route(post, api("subscriptions", "checkout", "confirm"), key),
      route(post, api("subscriptions", "cancel"), fresh),
      route(post, api("subscriptions", "cancel", "undo"), fresh),
      route(get, api("subscriptions", "cancel", ":commandId"), fresh),
      route(get, api("subscriptions", "cancel", "undo", ":commandId"), fresh),
      route(get, api("subscriptions", "cancel", "undo", "review"), fresh),
      route(post, api("subscriptions", "upgrade", "review"), fresh),
      route(post, api("subscriptions", "upgrade", "confirm"), fresh),
      route(post, api("subscriptions", "downgrade", "review"), fresh),
      route(post, api("subscriptions", "downgrade", "confirm"), fresh),
      route(get, api("subscriptions", "upgrade", ":commandId"), fresh),
      route(get, api("subscriptions", "downgrade", ":commandId"), fresh),
      route(post, api("subscriptions", "upgrade", ":commandId", "payment"), fresh),
      route(get, api("subscriptions", "commands"), key),
      route(post, api("subscriptions", "portal"), fresh),
      route(get, api("billing", "invoices"), key),
      route(get, api("billing", "invoices", ":invoiceId"), key),
      route(get, api("models"), key),
      route(post, api("chat", "completions"), key),
      route(post, api("voice", "tts"), key),
      route(post, api("voice", "stt"), key),
      route(post, api("voice", "speech", "consent"), key),
      route(post, api("voice", "speech", "session"), key),
      route(get, api("voice", "speech", "ws"), pub),
      route(post, api("voice", "speech", "session", ":sessionId", "revoke"), key),
      route(get, api("maps", "capabilities"), key),
      keyed(post, api("maps", "geocode"), IDEMPOTENCY_KEY),
      keyed(post, api("maps", "reverse"), IDEMPOTENCY_KEY),
      keyed(post, api("maps", "places", "search"), IDEMPOTENCY_KEY),
      keyed(post, api("maps", "places", "details"), IDEMPOTENCY_KEY),
      keyed(post, api("maps", "routes"), IDEMPOTENCY_KEY),
      route(post, api("maps", "tiles", "viewport"), key),
      keyed(get, api("maps", "tiles", ":z", ":x", ":y"), IDEMPOTENCY_KEY),
      route(get, google("status"), key),
      route(get, google("accounts"), key),
      route(post, google("connect", "initiate"), key),
      route(post, google("connect", "native"), key),
      route(post, google("disconnect"), key),
      route(get, google("gmail", "triage"), key),
      route(get, google("gmail", "search"), key),
      route(get, google("gmail", "read"), key),
      route(get, google("gmail", "inbox-v1", "capabilities"), key),
      route(get, google("gmail", "inbox-v1", "thread"), key),
      route(get, google("gmail", "inbox-v1", "attachment"), key),
      route(get, google("gmail", "inbox-v1", "drafts"), key),
      route(get, google("gmail", "inbox-v1", "draft"), key),
      route(post, google("gmail", "inbox-v1", "operations"), key),
      route(post, google("gmail", "inbox-v1", "operations", ":requestId", "dispatch"), key),
      route(get, google("gmail", "inbox-v1", "operations", ":requestId"), key),
      route(get, google("calendar", "calendars"), key),
      route(get, google("calendar", "feed"), key),
      route(get, google("calendar", "events", ":eventId"), key),
      keyed(post, google("calendar", "events"), IDEMPOTENCY_KEY),
      keyed(patch, google("calendar", "events", ":eventId"), IF_MATCH),
      keyed(delete, google("calendar", "events", ":eventId"), IF_MATCH));
  }
}
