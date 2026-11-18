// spec/agent/access/routes.md, "A list is loaded whole or not at all"; spec/agent/access/routes.md, "The first matching route of the claiming group admits a request, or finds its body too large"
package ai.eliza.os.agent;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

public final class RouteGate {
  public static final String FLAT_PARAM = "[A-Za-z0-9_-]{1,128}";
  public static final int PATH_LIMIT = 2048;

  public enum Method { GET, POST, PUT, PATCH, DELETE }
  public enum Delivery { BUFFERED, STREAMED }
  public enum AcceptKind { ANY_VALUE, MATCHING, PINNED }
  public enum Flaw { BACKSLASH, FRAGMENT, UNSAFE_CHARACTER, PERCENT_IN_PATH, MALFORMED_ESCAPE, PATH_TOO_LONG }
  public enum BodyKind { NO_BODY, JSON_OBJECT, NOT_AN_OBJECT }
  public enum Verdict { ADMITTED, ROUTE_REFUSED, TOO_LARGE }
  public enum Table { UNLOADED, REFUSED, LOADED }

  public record Piece(String literal) {
    public static final Piece PARAM = new Piece(null);
    public boolean isParam() { return literal == null; }
  }
  public record Accept(AcceptKind kind, String text) {
    public static final Accept ANY = new Accept(AcceptKind.ANY_VALUE, "");
  }
  public record QueryRule(String key, Accept accepts) {}
  public record Route(Method method, Delivery delivery, List<Piece> path, List<QueryRule> query, Long limit) {
    public Route { path = List.copyOf(path); query = List.copyOf(query); }
  }
  public record Group(List<List<String>> prefixes, String id, List<Route> routes) {
    public Group { prefixes = prefixes.stream().map(List::copyOf).toList(); routes = List.copyOf(routes); }
  }
  public record Segment(String text, List<String> fits) {
    public Segment { fits = List.copyOf(fits); }
  }
  public record QueryPair(String key, String value, List<String> fits) {
    public QueryPair { fits = List.copyOf(fits); }
  }
  public record Body(BodyKind kind, long size) {
    public static final Body NONE = new Body(BodyKind.NO_BODY, 0), NOT_AN_OBJECT = new Body(BodyKind.NOT_AN_OBJECT, 0);
  }
  public record Request(Method method, Delivery delivery, List<Segment> segments, List<QueryPair> query, List<Flaw> flaws, Body body) {
    public Request { segments = List.copyOf(segments); query = List.copyOf(query); flaws = List.copyOf(flaws); }
  }
  public record Admission(Verdict verdict, Route route) {
    public static final Admission ROUTE_REFUSED = new Admission(Verdict.ROUTE_REFUSED, null), TOO_LARGE = new Admission(Verdict.TOO_LARGE, null);
  }

  private static final Pattern WIRE_LITERAL = Pattern.compile("[A-Za-z0-9._-]+");
  private static final Pattern PLACEHOLDER = Pattern.compile("\\{[a-z][A-Za-z]*\\}");
  private static final Pattern UNSAFE = Pattern.compile("[\\u0000-\\u0020\\u007f\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]");
  private static final Set<String> ROUTE_KEYS = Set.of("method", "path", "stream", "query", "maxBodyBytes");
  private static final Set<String> GROUP_KEYS = Set.of("prefixes", "id", "routes");

  private Table table = Table.UNLOADED;
  private List<Group> groups = List.of();
  private Map<String, Pattern> idPatterns = Map.of(), valuePatterns = Map.of();

  public synchronized Table table() { return table; }

  public synchronized List<Group> served() { return groups; }

  public synchronized boolean load(List<Group> routes) {
    boolean valid = validList(routes);
    table = valid ? Table.LOADED : Table.REFUSED;
    groups = valid ? List.copyOf(routes) : List.of();
    Map<String, Pattern> ids = new LinkedHashMap<>(), values = new LinkedHashMap<>();
    for (Group group : groups) {
      compile(ids, group.id());
      for (Route route : group.routes())
        for (QueryRule rule : route.query()) if (rule.accepts().kind() == AcceptKind.MATCHING) compile(values, rule.accepts().text());
    }
    idPatterns = Collections.unmodifiableMap(ids);
    valuePatterns = Collections.unmodifiableMap(values);
    return valid;
  }

  public boolean loadWire(String json) {
    List<Group> decoded;
    try { decoded = decodeList(Json.parse(json)); }
    catch (IllegalArgumentException refused) { decoded = List.of(); }
    return load(decoded);
  }

  public synchronized Admission admit(Request request) {
    return request == null ? Admission.ROUTE_REFUSED : admission(groups, request);
  }

  public synchronized Request request(String method, String target, boolean streamed, byte[] body) {
    Method decoded = wireMethod(method);
    if (decoded == null || target == null) return null;
    List<Flaw> flaws = new ArrayList<>();
    int split = target.indexOf('?');
    String path = split < 0 ? target : target.substring(0, split), query = split < 0 ? "" : target.substring(split + 1);
    if (target.indexOf('\\') >= 0) flaws.add(Flaw.BACKSLASH);
    if (target.indexOf('#') >= 0) flaws.add(Flaw.FRAGMENT);
    if (UNSAFE.matcher(target).find()) flaws.add(Flaw.UNSAFE_CHARACTER);
    if (target.length() > PATH_LIMIT) flaws.add(Flaw.PATH_TOO_LONG);
    if (path.indexOf('%') >= 0) flaws.add(Flaw.PERCENT_IN_PATH);
    List<QueryPair> pairs = new ArrayList<>();
    if (!query.isEmpty() && flaws.isEmpty()) {
      for (String part : query.split("&", -1)) {
        int at = part.indexOf('=');
        String key = decodeComponent(at < 0 ? part : part.substring(0, at), flaws);
        String value = decodeComponent(at < 0 ? "" : part.substring(at + 1), flaws);
        pairs.add(new QueryPair(key, value, fits(valuePatterns, value)));
      }
    }
    List<Segment> segments = new ArrayList<>();
    if (flaws.isEmpty() && path.startsWith("/"))
      for (String text : path.substring(1).split("/", -1)) segments.add(new Segment(text, fits(idPatterns, text)));
    else segments.add(new Segment("", List.of()));
    return new Request(decoded, streamed ? Delivery.STREAMED : Delivery.BUFFERED, segments, pairs, flaws, flaws.isEmpty() ? requestBody(body) : Body.NONE);
  }

  public static boolean safeLiteral(String text) { return text != null && !text.isEmpty() && !text.equals(".") && !text.equals(".."); }

  public static boolean validList(List<Group> routes) {
    if (routes == null || routes.isEmpty()) return false;
    for (Group group : routes) if (!validGroup(routes, group)) return false;
    return true;
  }

  private static boolean validGroup(List<Group> routes, Group group) {
    if (group.prefixes().isEmpty() || group.routes().isEmpty()) return false;
    for (List<String> prefix : group.prefixes()) {
      for (String text : prefix) if (!safeLiteral(text)) return false;
      if (routes.stream().filter(other -> other.prefixes().contains(prefix)).count() != 1) return false;
      if (group.prefixes().stream().filter(prefix::equals).count() != 1) return false;
    }
    for (Route route : group.routes()) if (!validTemplate(route)) return false;
    return !group.id().isEmpty() || group.routes().stream().noneMatch(route -> route.path().stream().anyMatch(Piece::isParam));
  }

  private static boolean validTemplate(Route route) {
    for (Piece piece : route.path()) if (!piece.isParam() && !safeLiteral(piece.literal())) return false;
    if (route.limit() != null && route.limit() <= 0) return false;
    for (QueryRule rule : route.query())
      if (rule.key().isEmpty() || route.query().stream().filter(other -> other.key().equals(rule.key())).count() != 1) return false;
    return true;
  }

  private static boolean leads(List<String> prefix, List<Segment> segments) {
    if (prefix.size() > segments.size()) return false;
    for (int at = 0; at < prefix.size(); at++) if (!segments.get(at).text().equals(prefix.get(at))) return false;
    return true;
  }

  private static int claim(Group group, List<Segment> segments) {
    int best = -1;
    for (List<String> prefix : group.prefixes()) if (prefix.size() > best && leads(prefix, segments)) best = prefix.size();
    return best;
  }

  private static Group claimant(List<Group> routes, List<Segment> segments) {
    for (Group group : routes) {
      int own = claim(group, segments);
      if (own >= 0 && routes.stream().allMatch(other -> claim(other, segments) <= own)) return group;
    }
    return null;
  }

  private static boolean pathFits(Route route, String id, List<Segment> segments) {
    if (route.path().size() != segments.size()) return false;
    for (int at = 0; at < segments.size(); at++) {
      Piece piece = route.path().get(at);
      Segment segment = segments.get(at);
      if (piece.isParam() ? !segment.fits().contains(id) : !segment.text().equals(piece.literal())) return false;
    }
    return true;
  }

  private static boolean acceptsValue(Accept accepts, QueryPair pair) {
    return switch (accepts.kind()) {
      case MATCHING -> pair.fits().contains(accepts.text());
      case PINNED -> pair.value().equals(accepts.text());
      case ANY_VALUE -> true;
    };
  }

  private static boolean queryFits(Route route, List<QueryPair> query) {
    for (QueryPair pair : query)
      if (route.query().stream().noneMatch(rule -> rule.key().equals(pair.key()) && acceptsValue(rule.accepts(), pair))) return false;
    for (QueryRule rule : route.query())
      if (rule.accepts().kind() == AcceptKind.PINNED && query.stream().noneMatch(pair -> pair.key().equals(rule.key()) && pair.value().equals(rule.accepts().text()))) return false;
    return true;
  }

  private static boolean templateAdmits(Route route, String id, Request request) {
    return route.method() == request.method() && route.delivery() == request.delivery() && pathFits(route, id, request.segments()) && queryFits(route, request.query());
  }

  private static boolean wellFormed(Request request) {
    if (!request.flaws().isEmpty() || request.body().kind() == BodyKind.NOT_AN_OBJECT) return false;
    for (Segment segment : request.segments()) if (!safeLiteral(segment.text())) return false;
    for (QueryPair pair : request.query())
      if (request.query().stream().filter(other -> other.key().equals(pair.key())).count() != 1) return false;
    return !((request.method() == Method.GET || request.method() == Method.DELETE) && request.body().kind() != BodyKind.NO_BODY);
  }

  public static Admission admission(List<Group> routes, Request request) {
    Group group = claimant(routes, request.segments());
    Route matched = null;
    if (group != null) for (Route route : group.routes()) if (templateAdmits(route, group.id(), request)) { matched = route; break; }
    if (!wellFormed(request) || matched == null) return Admission.ROUTE_REFUSED;
    long size = request.body().kind() == BodyKind.JSON_OBJECT ? request.body().size() : 0;
    if (matched.limit() != null && size > matched.limit()) return Admission.TOO_LARGE;
    return new Admission(Verdict.ADMITTED, matched);
  }

  private static void compile(Map<String, Pattern> into, String pattern) {
    if (pattern.isEmpty() || into.containsKey(pattern)) return;
    try { into.put(pattern, Pattern.compile(pattern)); }
    catch (PatternSyntaxException unusable) { }
  }

  private static List<String> fits(Map<String, Pattern> patterns, String value) {
    List<String> fit = new ArrayList<>();
    for (Map.Entry<String, Pattern> entry : patterns.entrySet()) if (entry.getValue().matcher(value).matches()) fit.add(entry.getKey());
    return fit;
  }

  private static Method wireMethod(String method) {
    if (method == null) return null;
    return switch (method) {
      case "GET" -> Method.GET;
      case "POST" -> Method.POST;
      case "PUT" -> Method.PUT;
      case "PATCH" -> Method.PATCH;
      case "DELETE" -> Method.DELETE;
      default -> null;
    };
  }

  private static String decodeComponent(String part, List<Flaw> flaws) {
    if (part.indexOf('%') < 0) return part;
    ByteBuffer bytes = ByteBuffer.allocate(part.length() * 4);
    StringBuilder out = new StringBuilder();
    for (int at = 0; at < part.length();) {
      char c = part.charAt(at);
      if (c != '%') {
        if (bytes.position() > 0 && !flush(bytes, out)) { flaws.add(Flaw.MALFORMED_ESCAPE); return ""; }
        out.append(c);
        at++;
        continue;
      }
      int high = at + 2 < part.length() ? Character.digit(part.charAt(at + 1), 16) : -1, low = high >= 0 ? Character.digit(part.charAt(at + 2), 16) : -1;
      if (low < 0) { flaws.add(Flaw.MALFORMED_ESCAPE); return ""; }
      bytes.put((byte) (high * 16 + low));
      at += 3;
    }
    if (bytes.position() > 0 && !flush(bytes, out)) { flaws.add(Flaw.MALFORMED_ESCAPE); return ""; }
    return out.toString();
  }

  private static boolean flush(ByteBuffer bytes, StringBuilder out) {
    bytes.flip();
    try { out.append(StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(bytes)); }
    catch (CharacterCodingException malformed) { return false; }
    finally { bytes.clear(); }
    return true;
  }

  private static Body requestBody(byte[] bytes) {
    if (bytes == null) return Body.NONE;
    try {
      String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
      if (text.startsWith("﻿")) text = text.substring(1);
      return Json.parse(text) instanceof Map ? new Body(BodyKind.JSON_OBJECT, bytes.length) : Body.NOT_AN_OBJECT;
    } catch (CharacterCodingException | IllegalArgumentException malformed) {
      return Body.NOT_AN_OBJECT;
    }
  }

  private static List<Group> decodeList(Object value) {
    List<Object> items = array(value);
    if (items.isEmpty()) return List.of();
    if (object(items.get(0)).containsKey("method")) {
      List<Route> routes = new ArrayList<>();
      for (Object item : items) routes.add(decodeRoute(item));
      return List.of(new Group(List.of(List.of()), FLAT_PARAM, routes));
    }
    List<Group> decoded = new ArrayList<>();
    for (Object item : items) decoded.add(decodeGroup(item));
    return decoded;
  }

  private static Group decodeGroup(Object value) {
    Map<String, Object> group = exactly(value, GROUP_KEYS, Set.of("prefixes", "routes"));
    List<List<String>> prefixes = new ArrayList<>();
    for (Object prefix : array(group.get("prefixes"))) {
      String text = string(prefix);
      if (text.isEmpty()) { prefixes.add(List.of()); continue; }
      if (!text.startsWith("/")) throw new IllegalArgumentException("a prefix starts with /");
      List<String> literals = List.of(text.substring(1).split("/", -1));
      for (String literal : literals) if (!wireLiteral(literal)) throw new IllegalArgumentException("a prefix is literals only");
      prefixes.add(literals);
    }
    String id = group.containsKey("id") ? pattern(group.get("id")) : "";
    List<Route> routes = new ArrayList<>();
    for (Object route : array(group.get("routes"))) routes.add(decodeRoute(route));
    return new Group(prefixes, id, routes);
  }

  private static Route decodeRoute(Object value) {
    Map<String, Object> route = exactly(value, ROUTE_KEYS, Set.of("method", "path"));
    Method method = wireMethod(string(route.get("method")));
    if (method == null) throw new IllegalArgumentException("unknown method");
    String path = string(route.get("path"));
    if (!path.startsWith("/")) throw new IllegalArgumentException("a path starts with /");
    List<Piece> pieces = new ArrayList<>();
    for (String text : path.substring(1).split("/", -1)) {
      if (PLACEHOLDER.matcher(text).matches()) pieces.add(Piece.PARAM);
      else if (wireLiteral(text)) pieces.add(new Piece(text));
      else throw new IllegalArgumentException("a path segment is a literal or a {placeholder}");
    }
    Object stream = route.getOrDefault("stream", Boolean.FALSE);
    if (!(stream instanceof Boolean)) throw new IllegalArgumentException("stream is true or false");
    List<QueryRule> query = new ArrayList<>();
    if (route.containsKey("query")) for (Object rule : array(route.get("query"))) query.add(decodeQuery(rule));
    Long limit = null;
    if (route.containsKey("maxBodyBytes")) {
      if (!(route.get("maxBodyBytes") instanceof BigDecimal number) || number.signum() <= 0 || number.stripTrailingZeros().scale() > 0)
        throw new IllegalArgumentException("maxBodyBytes is a positive whole number");
      limit = number.longValueExact();
    }
    return new Route(method, (Boolean) stream ? Delivery.STREAMED : Delivery.BUFFERED, pieces, query, limit);
  }

  private static QueryRule decodeQuery(Object value) {
    Map<String, Object> rule = exactly(value, Set.of("key", "accepts"), Set.of("key", "accepts"));
    Map<String, Object> accepts = object(rule.get("accepts"));
    Accept accept = switch (string(accepts.get("kind"))) {
      case "any" -> { exactly(accepts, Set.of("kind"), Set.of("kind")); yield Accept.ANY; }
      case "pattern" -> new Accept(AcceptKind.MATCHING, pattern(exactly(accepts, Set.of("kind", "pattern"), Set.of("kind", "pattern")).get("pattern")));
      case "pinned" -> new Accept(AcceptKind.PINNED, string(exactly(accepts, Set.of("kind", "value"), Set.of("kind", "value")).get("value")));
      default -> throw new IllegalArgumentException("unknown query rule");
    };
    return new QueryRule(string(rule.get("key")), accept);
  }

  private static boolean wireLiteral(String text) { return WIRE_LITERAL.matcher(text).matches() && !text.chars().allMatch(c -> c == '.'); }

  private static String pattern(Object value) {
    String text = string(value);
    if (text.isEmpty()) throw new IllegalArgumentException("a pattern is not empty");
    try { Pattern.compile(text); }
    catch (PatternSyntaxException invalid) { throw new IllegalArgumentException("a pattern compiles", invalid); }
    return text;
  }

  private static Map<String, Object> exactly(Object value, Set<String> allowed, Set<String> required) {
    Map<String, Object> map = object(value);
    for (String key : map.keySet()) if (!allowed.contains(key)) throw new IllegalArgumentException("unexpected field " + key);
    for (String key : required) if (!map.containsKey(key)) throw new IllegalArgumentException("missing field " + key);
    return map;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> object(Object value) {
    if (value instanceof Map<?, ?> map) return (Map<String, Object>) map;
    throw new IllegalArgumentException("expected an object");
  }

  @SuppressWarnings("unchecked")
  private static List<Object> array(Object value) {
    if (value instanceof List<?> list) return (List<Object>) list;
    throw new IllegalArgumentException("expected an array");
  }

  private static String string(Object value) {
    if (value instanceof String text) return text;
    throw new IllegalArgumentException("expected text");
  }

  static final class Json {
    static final Object NULL = new Object();
    private final String text;
    private int at;

    private Json(String text) { this.text = text; }

    static Object parse(String text) {
      if (text == null) throw new IllegalArgumentException("no JSON");
      Json reader = new Json(text);
      reader.space();
      Object value = reader.value();
      reader.space();
      if (reader.at != text.length()) throw new IllegalArgumentException("text after the JSON value");
      return value;
    }

    private void space() { while (at < text.length() && " \t\n\r".indexOf(text.charAt(at)) >= 0) at++; }

    private char peek() {
      if (at >= text.length()) throw new IllegalArgumentException("unexpected end of JSON");
      return text.charAt(at);
    }

    private void expect(char c) {
      if (peek() != c) throw new IllegalArgumentException("expected " + c + " at " + at);
      at++;
    }

    private Object value() {
      char c = peek();
      switch (c) {
        case '{': return object();
        case '[': return array();
        case '"': return string();
        case 't': word("true"); return Boolean.TRUE;
        case 'f': word("false"); return Boolean.FALSE;
        case 'n': word("null"); return NULL;
        default: return number();
      }
    }

    private void word(String word) {
      if (!text.startsWith(word, at)) throw new IllegalArgumentException("unexpected JSON at " + at);
      at += word.length();
    }

    private Map<String, Object> object() {
      expect('{');
      Map<String, Object> map = new LinkedHashMap<>();
      space();
      if (peek() == '}') { at++; return map; }
      while (true) {
        space();
        String key = string();
        space();
        expect(':');
        space();
        map.put(key, value());
        space();
        if (peek() == ',') { at++; continue; }
        expect('}');
        return map;
      }
    }

    private List<Object> array() {
      expect('[');
      List<Object> list = new ArrayList<>();
      space();
      if (peek() == ']') { at++; return list; }
      while (true) {
        space();
        list.add(value());
        space();
        if (peek() == ',') { at++; continue; }
        expect(']');
        return list;
      }
    }

    private String string() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        char c = peek();
        at++;
        if (c == '"') return out.toString();
        if (c < 0x20) throw new IllegalArgumentException("control character in a JSON string");
        if (c != '\\') { out.append(c); continue; }
        char escape = peek();
        at++;
        switch (escape) {
          case '"', '\\', '/' -> out.append(escape);
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> {
            if (at + 4 > text.length()) throw new IllegalArgumentException("short unicode escape");
            int code = 0;
            for (int i = 0; i < 4; i++) {
              int digit = Character.digit(text.charAt(at + i), 16);
              if (digit < 0) throw new IllegalArgumentException("bad unicode escape");
              code = code * 16 + digit;
            }
            at += 4;
            out.append((char) code);
          }
          default -> throw new IllegalArgumentException("bad escape");
        }
      }
    }

    private BigDecimal number() {
      int start = at;
      if (peek() == '-') at++;
      if (peek() == '0') at++;
      else digits();
      if (at < text.length() && text.charAt(at) == '.') { at++; digits(); }
      if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
        at++;
        if (peek() == '+' || peek() == '-') at++;
        digits();
      }
      return new BigDecimal(text.substring(start, at));
    }

    private void digits() {
      int start = at;
      while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
      if (at == start) throw new IllegalArgumentException("expected a digit at " + start);
    }
  }
}
