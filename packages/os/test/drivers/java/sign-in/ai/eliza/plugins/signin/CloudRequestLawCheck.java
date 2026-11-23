// spec/os/signIn/cloudRequests.md, "A cloud table is loaded only when every route is a device route the page may use"; spec/os/signIn/cloudRequests.md, "A session-only route is sent only with a live account session, never with the device key"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A 401 goes to the credential with its reason and is not retried"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"; spec/os/signIn/cloudRequests.md, "Only an HTTPS page on the web host or a listed payment or consent host opens, in the system browser"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.RouteGate;
import ai.eliza.os.agent.RouteGate.Method;
import ai.eliza.plugins.signin.CloudRequestPolicy.*;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

public final class CloudRequestLawCheck {
  private CloudRequestLawCheck() {}

  private static final List<Holding> HOLDINGS = List.of(new Holding(0, false, false, false, false), new Holding(1, false, false, false, false),
    new Holding(2, true, false, true, false), new Holding(2, true, true, true, true), new Holding(0, true, true, false, false),
    new Holding(3, false, false, true, true), new Holding(3, false, false, true, false));
  private static final List<Origin> ORIGINS = List.of(new Origin(Scheme.HTTPS, false, false, false), new Origin(Scheme.HTTPS, false, true, false),
    new Origin(Scheme.HTTP, true, false, false), new Origin(Scheme.HTTP, false, false, false), new Origin(Scheme.OTHER_SCHEME, false, false, true));
  private static final List<List<String>> HEADER_LISTS = List.of(List.of(), List.of("Idempotency-Key"), List.of("If-Match"), List.of("Authorization"),
    List.of("Accept", "If-None-Match"), List.of("Cookie"), List.of("Content-Type", "X-Request-ID"));
  private static final List<String> HEADERS = List.of("Authorization", "Content-Type", "X-Request-ID", "Traceparent", "Tracestate", "Accept",
    "If-None-Match", "If-Match", "Idempotency-Key", "Cookie", "ETag");
  private static final List<Attach> ATTACHES = List.of(new Bare(), new WithKey(1), new WithSession(1), new WithKey(3), new WithLease(1));
  private static final List<Long> BYTES = List.of(0L, 8_388_608L, 8_388_609L, 67_108_864L, 67_108_865L);
  private static final List<String> WEB_HOSTS = List.of("web.cloud.test");
  private static final List<ExternalLink> LINKS = List.of(new ExternalLink(true, "billing.stripe.com", true, false),
    new ExternalLink(true, "billing.stripe.com.evil.test", true, false), new ExternalLink(false, "web.cloud.test", true, false),
    new ExternalLink(true, "web.cloud.test", true, false), new ExternalLink(true, "accounts.google.com", false, false),
    new ExternalLink(true, "checkout.stripe.com", true, true));
  private static final String WIRE_TABLE = "[{\"prefixes\":[\"/api/v1\"],\"id\":\"[A-Za-z0-9_-]{1,128}\",\"routes\":["
    + "{\"method\":\"GET\",\"path\":\"/api/v1/user\"},"
    + "{\"method\":\"POST\",\"path\":\"/api/v1/subscriptions/cancel\",\"maxBodyBytes\":64},"
    + "{\"method\":\"GET\",\"path\":\"/api/v1/eliza/google/calendar/feed\",\"query\":[{\"key\":\"timeMin\",\"accepts\":{\"kind\":\"any\"}}]},"
    + "{\"method\":\"PATCH\",\"path\":\"/api/v1/eliza/google/calendar/events/{eventId}\",\"maxBodyBytes\":4096},"
    + "{\"method\":\"DELETE\",\"path\":\"/api/v1/eliza/google/calendar/events/{eventId}\"}]}]";
  private static final List<String> REFUSED_TABLES = List.of(
    "[{\"prefixes\":[\"/api/v1\"],\"routes\":[{\"method\":\"POST\",\"path\":\"/api/v1/auth/refresh\"}]}]",
    "[{\"prefixes\":[\"/api/v1\"],\"routes\":[{\"method\":\"GET\",\"path\":\"/api/v1/agents\"}]}]",
    "[{\"prefixes\":[\"/api/v1\"],\"routes\":[{\"method\":\"POST\",\"path\":\"/api/v1/chat/completions\",\"stream\":true}]}]",
    "[{\"prefixes\":[\"/api/v1\"],\"routes\":[{\"method\":\"POST\",\"path\":\"/api/v1/voice/speech/consent\"}]}]");
  private static final List<String[]> WIRE_CALLS = List.of(
    new String[] {"GET", "/api/v1/user", null}, new String[] {"GET", "/api/v1/user?x=1", null},
    new String[] {"GET", "/api/v1/eliza/google/calendar/feed?timeMin=2026-01-01", null},
    new String[] {"PATCH", "/api/v1/eliza/google/calendar/events/e1", "{\"title\":\"a\"}"},
    new String[] {"DELETE", "/api/v1/eliza/google/calendar/events/e1", null},
    new String[] {"POST", "/api/v1/subscriptions/cancel", "{}"},
    new String[] {"POST", "/api/v1/subscriptions/cancel", "{\"reason\":\"" + "x".repeat(80) + "\"}"},
    new String[] {"GET", "/api/v1/models", null}, new String[] {"GET", "/api/v1/../user", null},
    new String[] {"GET", "/api/v1/user#f", null}, new String[] {"GET", "/api/v1/eliza/google/calendar/events/e%2F1", null});
  private static final List<Map<String, String>> WIRE_HEADERS = List.of(Map.of(), Map.of("if-match", "\"7\""),
    Map.of("authorization", "Bearer page"), Map.of("accept", "application/json", "If-None-Match", "\"e\""), Map.of("Idempotency-Key", "k1"),
    Map.of("Cookie", "a=b"));

  private static void emit(String fn, String result, String... args) {
    System.out.println("{\"fn\":\"" + fn + "\",\"args\":[" + String.join(",", args) + "],\"result\":" + result + "}");
  }

  private static String q(String text) { return CredentialJson.quote(text); }

  private static String tag(String tag) { return "{\"tag\":" + q(tag) + "}"; }

  private static String camel(String constant) {
    StringBuilder out = new StringBuilder();
    for (String word : constant.toLowerCase(Locale.ROOT).split("_")) out.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
    return out.toString();
  }

  private static String list(List<String> items) { return "[" + String.join(",", items) + "]"; }

  private static String texts(List<String> items) { return list(items.stream().map(CloudRequestLawCheck::q).toList()); }

  private static String method(Method m) { return q(camel(m.name())); }

  private static String piece(RouteGate.Piece p) { return p.isParam() ? tag("Param") : "{\"tag\":\"Literal\",\"text\":" + q(p.literal()) + "}"; }

  private static String accept(RouteGate.Accept a) {
    return switch (a.kind()) {
      case ANY_VALUE -> tag("AnyValue");
      case MATCHING -> "{\"tag\":\"Matching\",\"pattern\":" + q(a.text()) + "}";
      case PINNED -> "{\"tag\":\"Pinned\",\"value\":" + q(a.text()) + "}";
    };
  }

  private static String route(RouteGate.Route t) {
    return "{\"method\":" + method(t.method()) + ",\"delivery\":" + q(camel(t.delivery().name())) + ",\"path\":" + list(t.path().stream().map(CloudRequestLawCheck::piece).toList())
      + ",\"query\":" + list(t.query().stream().map(r -> "{\"key\":" + q(r.key()) + ",\"accepts\":" + accept(r.accepts()) + "}").toList())
      + ",\"limit\":" + (t.limit() == null ? tag("AnySize") : "{\"tag\":\"AtMost\",\"bytes\":" + t.limit() + "}") + "}";
  }

  private static String groups(List<RouteGate.Group> routes) {
    return list(routes.stream().map(g -> "{\"prefixes\":" + list(g.prefixes().stream().map(CloudRequestLawCheck::texts).toList()) + ",\"id\":" + q(g.id())
      + ",\"routes\":" + list(g.routes().stream().map(CloudRequestLawCheck::route).toList()) + "}").toList());
  }

  private static String request(RouteGate.Request r) {
    String body = switch (r.body().kind()) {
      case NO_BODY -> tag("NoBody");
      case JSON_OBJECT -> "{\"tag\":\"JsonObject\",\"size\":" + r.body().size() + "}";
      case NOT_AN_OBJECT -> tag("NotAnObject");
    };
    return "{\"method\":" + method(r.method()) + ",\"delivery\":" + q(camel(r.delivery().name()))
      + ",\"segments\":" + list(r.segments().stream().map(s -> "{\"text\":" + q(s.text()) + ",\"fits\":" + texts(s.fits()) + "}").toList())
      + ",\"query\":" + list(r.query().stream().map(p -> "{\"key\":" + q(p.key()) + ",\"value\":" + q(p.value()) + ",\"fits\":" + texts(p.fits()) + "}").toList())
      + ",\"flaws\":" + texts(r.flaws().stream().map(f -> camel(f.name())).toList()) + ",\"body\":" + body + "}";
  }

  private static String segments(List<String> path) {
    return list(path.stream().map(s -> s.startsWith(":") ? "{\"tag\":\"Param\",\"name\":" + q(s.substring(1)) + "}" : "{\"tag\":\"Literal\",\"text\":" + q(s) + "}").toList());
  }

  private static String deviceRoute(DeviceRoute d) {
    return "{\"method\":" + method(d.method()) + ",\"path\":" + segments(d.path()) + ",\"auth\":" + q(camel(d.auth().name())) + ",\"headers\":" + texts(d.headers()) + "}";
  }

  private static String holding(Holding h) {
    return "{\"key\":" + h.key() + ",\"sessionHeld\":" + h.sessionHeld() + ",\"sessionLive\":" + h.sessionLive()
      + ",\"leaseHeld\":" + h.leaseHeld() + ",\"leaseLive\":" + h.leaseLive() + "}";
  }

  private static String origin(Origin u) {
    return "{\"scheme\":" + q(camel(u.scheme().name())) + ",\"loopback\":" + u.loopback() + ",\"hasPath\":" + u.hasPath() + ",\"hasQueryOrFragment\":" + u.hasQueryOrFragment() + "}";
  }

  private static String attach(Attach a) {
    return switch (a) {
      case Bare b -> tag("Bare");
      case WithKey k -> "{\"tag\":\"WithKey\",\"version\":" + k.version() + "}";
      case WithSession s -> "{\"tag\":\"WithSession\",\"version\":" + s.version() + "}";
      case WithLease l -> "{\"tag\":\"WithLease\",\"version\":" + l.version() + "}";
    };
  }

  private static String plan(CallPlan p) {
    return switch (p) {
      case Send s -> "{\"tag\":\"Send\",\"attach\":" + attach(s.attach()) + "}";
      case RefreshSessionFirst r -> tag("RefreshSessionFirst");
      case RefreshLeaseFirst r -> tag("RefreshLeaseFirst");
      case Refuse r -> "{\"tag\":\"Refuse\",\"why\":" + q(camel(r.why().name())) + "}";
    };
  }

  private static String report(Report r) {
    return switch (r) {
      case NoReport n -> tag("NoReport");
      case KeyRejected k -> "{\"tag\":\"KeyRejected\",\"version\":" + k.version() + ",\"reason\":" + q(k.reason().tag) + ",\"on\":" + q(camel(k.on().name())) + "}";
      case LeaseRejected l -> "{\"tag\":\"LeaseRejected\",\"version\":" + l.version() + ",\"reason\":" + q(l.reason().tag) + "}";
      case SessionRejected s -> tag("SessionRejected");
    };
  }

  private static String link(ExternalLink l) {
    return "{\"https\":" + l.https() + ",\"host\":" + q(l.host()) + ",\"defaultPort\":" + l.defaultPort() + ",\"userInfo\":" + l.userInfo() + "}";
  }

  private static List<RouteGate.Piece> at(String... names) {
    List<RouteGate.Piece> path = new ArrayList<>(List.of(new RouteGate.Piece("api"), new RouteGate.Piece("v1")));
    for (String name : names) path.add(new RouteGate.Piece(name));
    return path;
  }

  private static RouteGate.Segment seg(String text) { return new RouteGate.Segment(text, List.of()); }

  private static List<List<RouteGate.Group>> specTables() {
    RouteGate.Route read = new RouteGate.Route(Method.GET, RouteGate.Delivery.BUFFERED, at("user"), List.of(), null);
    List<RouteGate.Piece> events = at("eliza", "google", "calendar", "events");
    events.add(RouteGate.Piece.PARAM);
    List<RouteGate.Route> routes = List.of(read,
      new RouteGate.Route(Method.GET, RouteGate.Delivery.BUFFERED, at("subscriptions", "plans"), List.of(), null),
      new RouteGate.Route(Method.POST, RouteGate.Delivery.BUFFERED, at("subscriptions", "cancel"), List.of(), 20L),
      new RouteGate.Route(Method.GET, RouteGate.Delivery.BUFFERED, at("eliza", "google", "calendar", "feed"), List.of(new RouteGate.QueryRule("timeMin", RouteGate.Accept.ANY)), null),
      new RouteGate.Route(Method.PATCH, RouteGate.Delivery.BUFFERED, events, List.of(), 20L));
    List<List<String>> prefixes = List.of(List.of("api", "v1"));
    List<RouteGate.Route> foreign = new ArrayList<>(routes);
    foreign.add(new RouteGate.Route(Method.GET, RouteGate.Delivery.BUFFERED, at("agents"), List.of(), null));
    List<RouteGate.Route> signIn = new ArrayList<>(routes);
    signIn.add(new RouteGate.Route(Method.POST, RouteGate.Delivery.BUFFERED, at("auth", "refresh"), List.of(), null));
    List<RouteGate.Route> streamed = new ArrayList<>(routes);
    streamed.add(new RouteGate.Route(Method.POST, RouteGate.Delivery.STREAMED, at("chat", "completions"), List.of(), null));
    return List.of(List.of(new RouteGate.Group(prefixes, "id", routes)), List.of(new RouteGate.Group(prefixes, "id", foreign)),
      List.of(new RouteGate.Group(prefixes, "id", signIn)), List.of(new RouteGate.Group(prefixes, "id", streamed)));
  }

  private static List<RouteGate.Request> specRequests() {
    RouteGate.Request user = new RouteGate.Request(Method.GET, RouteGate.Delivery.BUFFERED, List.of(seg("api"), seg("v1"), seg("user")), List.of(), List.of(), RouteGate.Body.NONE);
    List<RouteGate.Segment> cancelPath = List.of(seg("api"), seg("v1"), seg("subscriptions"), seg("cancel"));
    RouteGate.Request cancel = new RouteGate.Request(Method.POST, RouteGate.Delivery.BUFFERED, cancelPath, List.of(), List.of(), new RouteGate.Body(RouteGate.BodyKind.JSON_OBJECT, 5));
    List<RouteGate.Segment> calendar = List.of(seg("api"), seg("v1"), seg("eliza"), seg("google"), seg("calendar"));
    List<RouteGate.Segment> feed = new ArrayList<>(calendar);
    feed.add(seg("feed"));
    List<RouteGate.Segment> event = new ArrayList<>(calendar);
    event.add(seg("events"));
    event.add(new RouteGate.Segment("e1", List.of("id")));
    return List.of(user, cancel,
      new RouteGate.Request(Method.POST, RouteGate.Delivery.BUFFERED, cancelPath, List.of(), List.of(), new RouteGate.Body(RouteGate.BodyKind.JSON_OBJECT, 30)),
      new RouteGate.Request(Method.GET, RouteGate.Delivery.BUFFERED, feed, List.of(new RouteGate.QueryPair("timeMin", "0", List.of())), List.of(), RouteGate.Body.NONE),
      new RouteGate.Request(Method.PATCH, RouteGate.Delivery.BUFFERED, event, List.of(), List.of(), new RouteGate.Body(RouteGate.BodyKind.JSON_OBJECT, 5)),
      new RouteGate.Request(Method.GET, RouteGate.Delivery.BUFFERED, List.of(seg("api"), seg("v1"), seg("models")), List.of(), List.of(), RouteGate.Body.NONE));
  }

  private static boolean refused(CallPlan p) { return p instanceof Refuse; }

  private static int sentKey(CallPlan p) { return p instanceof Send s && s.attach() instanceof WithKey k ? k.version() : 0; }

  private static int sentLease(CallPlan p) { return p instanceof Send s && s.attach() instanceof WithLease l ? l.version() : 0; }

  private static void specCases() {
    emit("deviceRoutes", list(CloudRequestPolicy.DEVICE_ROUTES.stream().map(CloudRequestLawCheck::deviceRoute).toList()));
    List<DeviceRoute> attachRoutes = new ArrayList<>(CloudRequestPolicy.DEVICE_ROUTES);
    attachRoutes.add(CloudRequestPolicy.NO_DEVICE_ROUTE);
    for (Holding h : HOLDINGS)
      for (DeviceRoute d : attachRoutes) {
        String[] args = {holding(h), deviceRoute(d)};
        CallPlan p = CloudRequestPolicy.attachFor(h, d);
        boolean mail = CloudRequestPolicy.mailRoute(d);
        emit("attachFor", plan(p), args);
        emit("lawASessionRouteNeverCarriesTheKey", String.valueOf(!CloudRequestPolicy.sessionOnly(d.auth()) || sentKey(p) == 0), args);
        emit("lawAKeyRouteWithoutAKeyIsNotSent", String.valueOf(!(d.auth() == Auth.KEY_OR_SESSION && h.key() < 1) || p.equals(new Refuse(Refusal.SIGN_IN_REQUIRED))), args);
        emit("lawAMailRouteNeverCarriesTheKey", String.valueOf(!mail || sentKey(p) == 0), args);
        emit("lawTheLeaseGoesOnlyToAMailRoute", String.valueOf(sentLease(p) < 1 || mail), args);
      }
    for (DeviceRoute d : CloudRequestPolicy.DEVICE_ROUTES) {
      emit("mailRoute", String.valueOf(CloudRequestPolicy.mailRoute(d)), deviceRoute(d));
      emit("signInOwned", String.valueOf(CloudRequestPolicy.signInOwned(d)), deviceRoute(d));
      emit("isAccountRead", String.valueOf(CloudRequestPolicy.isAccountRead(d)), deviceRoute(d));
      for (String header : HEADERS) emit("headerAllowed", String.valueOf(CloudRequestPolicy.headerAllowed(d, header)), deviceRoute(d), q(header));
    }
    List<DeviceRoute> reportRoutes = List.of(CloudRequestPolicy.NO_DEVICE_ROUTE, new DeviceRoute(Method.GET, List.of("api", "v1", "user"), Auth.KEY_OR_SESSION, List.of()),
      new DeviceRoute(Method.GET, List.of("api", "v1", "eliza", "google", "calendar", "feed"), Auth.MAIL, List.of()),
      new DeviceRoute(Method.GET, List.of("api", "v1", "models"), Auth.KEY_OR_SESSION, List.of()));
    for (Attach a : ATTACHES)
      for (DeviceRoute d : reportRoutes)
        for (int status : List.of(200, 401, 403))
          for (Reason reason : Reason.values()) {
            Report r = CloudRequestPolicy.reportOf(a, d, status, reason);
            String[] args = {attach(a), deviceRoute(d), String.valueOf(status), q(reason.tag)};
            emit("reportOf", report(r), args);
            emit("lawOnlyA401WithACredentialIsReported", String.valueOf(!(r instanceof NoReport) == (status == 401 && !(a instanceof Bare))), args);
            emit("lawASession401NeverReachesTheKey", String.valueOf((r instanceof KeyRejected) == (status == 401 && a instanceof WithKey k && k.version() >= 1)), args);
          }
    for (Reason reason : Reason.values()) emit("credentialReasonOf", q(CloudRequestPolicy.credentialReasonOf(reason).tag), q(reason.tag));
    for (long bytes : BYTES) {
      emit("handoffOf", q(camel(CloudRequestPolicy.handoffOf(bytes).name())), String.valueOf(bytes));
      emit("lawOnlyAnOversizeBodyIsRefused", String.valueOf((CloudRequestPolicy.handoffOf(bytes) == Handoff.REPLY_TOO_LARGE) == (bytes > CloudRequestPolicy.REPLY_LIMIT)), String.valueOf(bytes));
    }
    for (String webHost : WEB_HOSTS)
      for (ExternalLink l : LINKS) {
        boolean opens = CloudRequestPolicy.opensExternally(webHost, l);
        emit("opensExternally", String.valueOf(opens), q(webHost), link(l));
        emit("lawALinkOpensOnlyOnAListedHost", String.valueOf(!opens || l.host().equals(webHost) || CloudRequestPolicy.PROVIDER_HOSTS.contains(l.host())), q(webHost), link(l));
      }
    for (Origin u : ORIGINS) emit("originAccepted", String.valueOf(CloudRequestPolicy.originAccepted(u)), origin(u));
    for (List<RouteGate.Group> table : specTables()) {
      boolean accepted = CloudRequestPolicy.cloudTableAccepted(table);
      emit("cloudTableAccepted", String.valueOf(accepted), groups(table));
      for (RouteGate.Group g : table) for (RouteGate.Route t : g.routes()) {
        emit("pageRoute", String.valueOf(CloudRequestPolicy.pageRoute(t)), route(t));
        emit("deviceRouteOf", list(CloudRequestPolicy.deviceRouteOf(t).stream().map(CloudRequestLawCheck::deviceRoute).toList()), route(t));
      }
      RouteGate gate = new RouteGate();
      gate.load(accepted ? table : List.of());
      emit("lawOneForeignRouteRefusesTheTable", String.valueOf(accepted || gate.served().isEmpty()), groups(table));
      for (Holding h : HOLDINGS)
        for (Origin u : ORIGINS)
          for (RouteGate.Request r : specRequests())
            for (List<String> headers : HEADER_LISTS) {
              CallPlan p = CloudRequestPolicy.planRequest(table, h, u, r, headers);
              String[] args = {groups(table), holding(h), origin(u), request(r), texts(headers)};
              emit("planRequest", plan(p), args);
              RouteGate.Admission a = RouteGate.admission(table, r);
              emit("lawASentRequestIsAdmittedOnTheOrigin", String.valueOf(refused(p)
                || CloudRequestPolicy.originAccepted(u) && a.verdict() == RouteGate.Verdict.ADMITTED && !headers.contains("Authorization")), args);
            }
    }
  }

  private static void wireCases() {
    CloudRequestPolicy loaded = new CloudRequestPolicy(WIRE_TABLE);
    RouteGate parsed = new RouteGate();
    parsed.loadWire(WIRE_TABLE);
    emit("cloudTableAccepted", String.valueOf(loaded.loaded()), groups(parsed.served()));
    for (String table : REFUSED_TABLES) {
      RouteGate refused = new RouteGate();
      if (!refused.loadWire(table)) throw new IllegalStateException("the refused table does not parse: " + table);
      emit("cloudTableAccepted", String.valueOf(new CloudRequestPolicy(table).loaded()), groups(refused.served()));
    }
    Origin https = CloudRequestPolicy.originOf("https://api.cloud.test");
    for (String[] call : WIRE_CALLS)
      for (Map<String, String> headers : WIRE_HEADERS)
        for (Holding h : HOLDINGS) {
          byte[] body = call[2] == null ? null : call[2].getBytes(StandardCharsets.UTF_8);
          Planned planned = loaded.plan(h, https, call[0], call[1], headers, body);
          RouteGate.Request request = parsed.request(call[0], call[1], false, body);
          emit("planRequest", plan(planned.plan()), groups(parsed.served()), holding(h), origin(https), request(request), texts(List.copyOf(planned.headers().keySet())));
        }
    Map<String, String> origins = new LinkedHashMap<>();
    for (String text : List.of("https://api.cloud.test", "https://api.cloud.test/", "https://api.cloud.test/v1", "http://127.0.0.1:8080", "http://api.cloud.test",
        "https://user@api.cloud.test", "https://api.cloud.test?x=1", "ftp://api.cloud.test", "not a url"))
      origins.put(text, String.valueOf(CloudRequestPolicy.originAccepted(CloudRequestPolicy.originOf(text))));
    System.out.println("{\"fn\":\"originOf\",\"accepted\":{" + origins.entrySet().stream().map(e -> q(e.getKey()) + ":" + e.getValue()).collect(Collectors.joining(",")) + "}}");
  }

  public static void main(String[] args) {
    specCases();
    wireCases();
  }
}
