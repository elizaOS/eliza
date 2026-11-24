// spec/os/signIn/cloudRequests.md, "A cloud table is loaded only when every route is a device route the page may use"; spec/os/signIn/cloudRequests.md, "A session-only route is sent only with a live account session, never with the device key"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A 401 goes to the credential with its reason and is not retried"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"; spec/os/signIn/cloudRequests.md, "Only an HTTPS page on the web host or a listed payment or consent host opens, in the system browser"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.RouteGate;
import ai.eliza.os.agent.RouteGate.Method;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.CredentialPolicy.RejectedOn;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

public final class CloudRequestPolicy {
  public static final long INLINE_LIMIT = 8_388_608L;
  public static final long REPLY_LIMIT = 67_108_864L;
  public static final List<String> PROVIDER_HOSTS = List.of("checkout.stripe.com", "billing.stripe.com", "accounts.google.com");
  public static final String IDEMPOTENCY_KEY = "Idempotency-Key", IF_MATCH = "If-Match", IF_NONE_MATCH = "If-None-Match", ACCEPT = "Accept", AUTHORIZATION = "Authorization";
  public static final List<String> BASE_HEADERS = List.of(AUTHORIZATION, "Content-Type", "X-Request-ID", "Traceparent", "Tracestate");

  public enum Auth { PUBLIC, KEY_OR_SESSION, SESSION, SESSION_FAMILY, FRESH_SESSION, STEP_UP }
  public enum Refusal { NO_ORIGIN, NOT_LISTED, BODY_TOO_LARGE, HEADER_REFUSED, SIGN_IN_REQUIRED, REAUTH_REQUIRED }
  public enum Handoff { INLINE_BODY, CACHED_BODY, REPLY_TOO_LARGE }
  public enum Scheme { HTTPS, HTTP, OTHER_SCHEME }

  public record DeviceRoute(Method method, List<String> path, Auth auth, List<String> headers) {
    public DeviceRoute { path = List.copyOf(path); headers = List.copyOf(headers); }
  }

  public record Holding(int key, boolean sessionHeld, boolean sessionLive) {}

  public sealed interface Attach permits Bare, WithKey, WithSession {}
  public record Bare() implements Attach {}
  public record WithKey(int version) implements Attach {}
  public record WithSession(int version) implements Attach {}

  public sealed interface CallPlan permits Send, RefreshSessionFirst, Refuse {}
  public record Send(Attach attach) implements CallPlan {}
  public record RefreshSessionFirst() implements CallPlan {}
  public record Refuse(Refusal why) implements CallPlan {}

  public sealed interface Report permits NoReport, KeyRejected, SessionRejected {}
  public record NoReport() implements Report {}
  public record KeyRejected(int version, Reason reason, RejectedOn on) implements Report {}
  public record SessionRejected() implements Report {}

  public record Origin(Scheme scheme, boolean loopback, boolean hasPath, boolean hasQueryOrFragment) {}
  public record ExternalLink(boolean https, String host, boolean defaultPort, boolean userInfo) {}

  public record Planned(CallPlan plan, DeviceRoute route, Map<String, String> headers) {}

  public static final DeviceRoute NO_DEVICE_ROUTE = new DeviceRoute(Method.GET, List.of(), Auth.PUBLIC, List.of());
  public static final List<DeviceRoute> DEVICE_ROUTES = deviceRoutes();

  private static final List<String> KNOWN_HEADERS = List.of(AUTHORIZATION, "Content-Type", "X-Request-ID", "Traceparent", "Tracestate", ACCEPT, IF_NONE_MATCH, IF_MATCH, IDEMPOTENCY_KEY);
  private static final Pattern HEADER_VALUE = Pattern.compile("[\\x20-\\x7e\\t]*");
  private static final Pattern REASON = Pattern.compile("[a-z_]{1,64}");

  private final RouteGate gate = new RouteGate();

  public CloudRequestPolicy(String consumerTable) {
    RouteGate parsed = new RouteGate();
    boolean accepted = consumerTable != null && parsed.loadWire(consumerTable) && cloudTableAccepted(parsed.served());
    gate.load(accepted ? parsed.served() : List.of());
  }

  public boolean loaded() { return gate.table() == RouteGate.Table.LOADED; }

  public Planned plan(Holding holding, Origin origin, String method, String target, Map<String, String> callerHeaders, byte[] body) {
    RouteGate.Request request = gate.request(method, target, false, body);
    if (request == null) return new Planned(new Refuse(originAccepted(origin) ? Refusal.NOT_LISTED : Refusal.NO_ORIGIN), NO_DEVICE_ROUTE, Map.of());
    Map<String, String> headers = new LinkedHashMap<>();
    boolean malformed = false;
    for (Map.Entry<String, String> header : callerHeaders.entrySet()) {
      String name = canonicalHeader(header.getKey());
      String value = header.getValue();
      malformed |= value == null || !HEADER_VALUE.matcher(value).matches() || headers.put(name, value) != null;
    }
    CallPlan plan = planRequest(gate.served(), holding, origin, request, List.copyOf(headers.keySet()));
    if (malformed && !(plan instanceof Refuse)) plan = new Refuse(Refusal.HEADER_REFUSED);
    RouteGate.Admission admission = RouteGate.admission(gate.served(), request);
    List<DeviceRoute> found = admission.route() == null ? List.of() : deviceRouteOf(admission.route());
    return new Planned(plan, found.size() == 1 ? found.get(0) : NO_DEVICE_ROUTE, Map.copyOf(headers));
  }

  public static List<DeviceRoute> deviceRouteOf(RouteGate.Route t) {
    List<DeviceRoute> found = new ArrayList<>();
    for (DeviceRoute d : DEVICE_ROUTES) if (t.method() == d.method() && samePath(t, d)) found.add(d);
    return found;
  }

  private static boolean samePath(RouteGate.Route t, DeviceRoute d) {
    if (t.path().size() != d.path().size()) return false;
    for (int at = 0; at < d.path().size(); at++) {
      RouteGate.Piece piece = t.path().get(at);
      String segment = d.path().get(at);
      boolean param = segment.startsWith(":");
      if (param ? !piece.isParam() : piece.isParam() || !segment.equals(piece.literal())) return false;
    }
    return true;
  }

  private static boolean under(DeviceRoute d, String... names) {
    if (d.path().size() < names.length) return false;
    for (int at = 0; at < names.length; at++) if (!d.path().get(at).equals(names[at])) return false;
    return true;
  }

  public static boolean signInOwned(DeviceRoute d) {
    return under(d, "api", "v1", "auth") || under(d, "api", "v1", "app-auth") || under(d, "api", "v1", "api-keys")
      || under(d, "api", "public") || under(d, "api", "v1", "voice", "speech");
  }

  public static boolean pageRoute(RouteGate.Route t) {
    List<DeviceRoute> found = deviceRouteOf(t);
    return t.delivery() == RouteGate.Delivery.BUFFERED && found.size() == 1 && !signInOwned(found.get(0));
  }

  public static boolean cloudTableAccepted(List<RouteGate.Group> routes) {
    for (RouteGate.Group group : routes) for (RouteGate.Route t : group.routes()) if (!pageRoute(t)) return false;
    return true;
  }

  public static boolean sessionOnly(Auth auth) {
    return auth == Auth.SESSION || auth == Auth.SESSION_FAMILY || auth == Auth.FRESH_SESSION || auth == Auth.STEP_UP;
  }

  public static CallPlan attachFor(Holding h, Auth auth) {
    if (auth == Auth.PUBLIC) return new Send(new Bare());
    if (sessionOnly(auth)) return h.sessionLive() ? new Send(new WithSession(h.key())) : h.sessionHeld() ? new RefreshSessionFirst() : new Refuse(Refusal.REAUTH_REQUIRED);
    return h.key() >= 1 ? new Send(new WithKey(h.key())) : new Refuse(Refusal.SIGN_IN_REQUIRED);
  }

  public static boolean admitsHeader(DeviceRoute d, String header) { return BASE_HEADERS.contains(header) || d.headers().contains(header); }

  public static boolean headerAllowed(DeviceRoute d, String header) {
    return !AUTHORIZATION.equals(header) && (admitsHeader(d, header) || ACCEPT.equals(header) || IF_NONE_MATCH.equals(header) && d.method() == Method.GET);
  }

  public static boolean originAccepted(Origin u) {
    return !u.hasPath() && !u.hasQueryOrFragment() && (u.scheme() == Scheme.HTTPS || u.scheme() == Scheme.HTTP && u.loopback());
  }

  public static Origin originOf(String apiOrigin) {
    URI uri;
    try { uri = new URI(apiOrigin); }
    catch (URISyntaxException | NullPointerException malformed) { return new Origin(Scheme.OTHER_SCHEME, false, false, false); }
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT), host = uri.getHost() == null ? "" : uri.getHost();
    Scheme kind = scheme.equals("https") ? Scheme.HTTPS : scheme.equals("http") ? Scheme.HTTP : Scheme.OTHER_SCHEME;
    boolean loopback = host.equals("localhost") || host.equals("[::1]") || host.matches("127(\\.\\d{1,3}){3}");
    String path = uri.getRawPath();
    return new Origin(host.isEmpty() || uri.getRawUserInfo() != null ? Scheme.OTHER_SCHEME : kind, loopback,
      path != null && !path.isEmpty(), uri.getRawQuery() != null || uri.getRawFragment() != null);
  }

  public static CallPlan planRequest(List<RouteGate.Group> routes, Holding h, Origin origin, RouteGate.Request request, List<String> headers) {
    RouteGate.Admission a = RouteGate.admission(routes, request);
    List<DeviceRoute> found = a.route() == null ? List.of() : deviceRouteOf(a.route());
    DeviceRoute d = found.isEmpty() ? NO_DEVICE_ROUTE : found.get(0);
    if (!originAccepted(origin)) return new Refuse(Refusal.NO_ORIGIN);
    if (a.verdict() == RouteGate.Verdict.TOO_LARGE) return new Refuse(Refusal.BODY_TOO_LARGE);
    if (a.verdict() != RouteGate.Verdict.ADMITTED || found.size() != 1) return new Refuse(Refusal.NOT_LISTED);
    for (String header : headers) if (!headerAllowed(d, header)) return new Refuse(Refusal.HEADER_REFUSED);
    return attachFor(h, d.auth());
  }

  public static boolean isAccountRead(DeviceRoute d) { return d.method() == Method.GET && d.path().equals(List.of("api", "v1", "user")); }

  public static Reason credentialReasonOf(Reason reason) { return reason.credential() ? reason : Reason.CREDENTIAL_UNKNOWN; }

  public static Report reportOf(Attach attach, DeviceRoute d, int status, Reason reason) {
    if (status != 401) return new NoReport();
    return switch (attach) {
      case WithKey k -> new KeyRejected(k.version(), credentialReasonOf(reason), isAccountRead(d) ? RejectedOn.ACCOUNT_READ : RejectedOn.OTHER_REQUEST);
      case WithSession s -> new SessionRejected();
      case Bare b -> new NoReport();
    };
  }

  public static Reason reasonOf(String body) {
    if (body == null) return Reason.NO_REASON;
    try {
      return CredentialJson.parse(body) instanceof Map<?, ?> reply && reply.get("reason") instanceof String wire && REASON.matcher(wire).matches()
        ? Reason.ofWire(wire) : Reason.NO_REASON;
    } catch (IllegalArgumentException notJson) {
      return Reason.NO_REASON;
    }
  }

  public static Handoff handoffOf(long bytes) {
    return bytes > REPLY_LIMIT ? Handoff.REPLY_TOO_LARGE : bytes > INLINE_LIMIT ? Handoff.CACHED_BODY : Handoff.INLINE_BODY;
  }

  public static ExternalLink linkOf(String url) {
    try {
      URI uri = new URI(url);
      String host = uri.getHost();
      if (host == null) return null;
      return new ExternalLink("https".equalsIgnoreCase(uri.getScheme()), host.toLowerCase(Locale.ROOT), uri.getPort() == -1 || uri.getPort() == 443, uri.getRawUserInfo() != null);
    } catch (URISyntaxException | NullPointerException malformed) {
      return null;
    }
  }

  public static boolean opensExternally(String webHost, ExternalLink link) {
    return link.https() && link.defaultPort() && !link.userInfo() && (link.host().equals(webHost) || PROVIDER_HOSTS.contains(link.host()));
  }

  private static String canonicalHeader(String name) {
    for (String known : KNOWN_HEADERS) if (known.equalsIgnoreCase(name)) return known;
    return name;
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

  private static DeviceRoute route(Method method, List<String> path, Auth auth) { return new DeviceRoute(method, path, auth, List.of()); }

  private static DeviceRoute keyed(Method method, List<String> path, String header) { return new DeviceRoute(method, path, Auth.KEY_OR_SESSION, List.of(header)); }

  private static List<DeviceRoute> deviceRoutes() {
    Method get = Method.GET, post = Method.POST, patch = Method.PATCH, delete = Method.DELETE;
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
      route(post, api("auth", "logout"), Auth.SESSION_FAMILY),
      route(post, api("auth", "mfa", "step-up"), session),
      route(get, api("auth", "mfa"), session),
      route(post, api("auth", "mfa", "totp", "enroll"), session),
      route(post, api("auth", "mfa", "totp", "confirm"), session),
      route(post, api("auth", "mfa", "sms", "enroll"), session),
      route(post, api("auth", "mfa", "sms", "confirm"), session),
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
      route(post, api("app-auth", "mobile", "renew"), key),
      keyed(delete, api("api-keys", "current"), DeviceKeyClient.RENEWED_CREDENTIAL),
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
      route(post, api("decisions"), key),
      keyed(post, api("chat", "completions"), IDEMPOTENCY_KEY),
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
      route(get, google("gmail", "inbox-v1", "arrival"), key),
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
