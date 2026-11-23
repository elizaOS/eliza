// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"
package ai.eliza.os.agent;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

public final class ChannelAdapter {
  private static final BigDecimal SAFE = BigDecimal.valueOf(9_007_199_254_740_991L);

  private ChannelPolicy policy = new ChannelPolicy();
  private List<ChannelPolicy.Out> out = List.of();

  public static void main(String[] args) throws Exception {
    ChannelAdapter adapter = new ChannelAdapter();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = input.readLine()) != null;) {
      if (line.isBlank()) continue;
      try { output.println(adapter.answer(line)); }
      catch (RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
    }
  }

  private String answer(String line) {
    Map<String, Object> request = object(RouteGate.Json.parse(line));
    if (!request.containsKey("event") && !request.containsKey("raw")) {
      policy = new ChannelPolicy();
      out = List.of();
      return "{\"state\":" + state() + ",\"out\":[]}";
    }
    Object event = request.containsKey("event") ? request.get("event") : request.get("raw");
    ChannelPolicy.Step step;
    try { step = dispatch(object(event)); }
    catch (IllegalArgumentException malformed) { step = new ChannelPolicy.Step(false, List.of()); }
    out = step.out();
    return "{\"outcome\":\"" + (step.allowed() ? "accepted" : "refused") + "\",\"state\":" + state() + ",\"out\":" + outs(out) + "}";
  }

  private ChannelPolicy.Step dispatch(Map<String, Object> event) {
    switch (text(event.get("type"))) {
      case "loadRoutes": {
        ChannelPolicy.CallerKind kind = named(ChannelPolicy.CallerKind.values(), event.get("kind"));
        List<RouteGate.Group> groups = list(event.get("routes"), ChannelAdapter::group);
        policy.loadRoutes(kind, groups);
        return new ChannelPolicy.Step(true, List.of());
      }
      case "open": return policy.open(whole(event.get("epoch")), text(event.get("rootToken")));
      case "ask": {
        ChannelPolicy.CallerKind kind = named(ChannelPolicy.CallerKind.values(), event.get("kind"));
        String owner = text(event.get("owner")), id = text(event.get("id"));
        return policy.ask(kind, owner, id, request(event.get("request")), list(event.get("headers"), ChannelAdapter::header));
      }
      case "reply": {
        long seq = whole(event.get("seq"));
        return policy.reply(seq, frame(event.get("frame")));
      }
      case "lost": return policy.lost(whole(event.get("seq")));
      case "abort": {
        String owner = text(event.get("owner")), id = text(event.get("id"));
        return policy.abort(owner, id);
      }
      case "retire": return policy.retire(whole(event.get("epoch")));
      case "subscribe": {
        String owner = text(event.get("owner")), id = text(event.get("id"));
        return policy.subscribe(owner, id, named(ChannelPolicy.Topic.values(), event.get("topic")));
      }
      default: throw new IllegalArgumentException("not an event of the channel");
    }
  }

  private static RouteGate.Group group(Object value) {
    Map<String, Object> group = object(value);
    List<List<String>> prefixes = list(group.get("prefixes"), prefix -> list(prefix, ChannelAdapter::text));
    String id = text(group.get("id"));
    return new RouteGate.Group(prefixes, id, list(group.get("routes"), ChannelAdapter::route));
  }

  private static RouteGate.Route route(Object value) {
    Map<String, Object> route = object(value);
    RouteGate.Method method = named(RouteGate.Method.values(), route.get("method"));
    RouteGate.Delivery delivery = named(RouteGate.Delivery.values(), route.get("delivery"));
    List<RouteGate.Piece> path = list(route.get("path"), piece -> {
      Map<String, Object> fields = object(piece);
      return switch (text(fields.get("tag"))) {
        case "Literal" -> new RouteGate.Piece(text(fields.get("text")));
        case "Param" -> RouteGate.Piece.PARAM;
        default -> throw new IllegalArgumentException("not a piece");
      };
    });
    List<RouteGate.QueryRule> query = list(route.get("query"), rule -> {
      Map<String, Object> fields = object(rule);
      String key = text(fields.get("key"));
      Map<String, Object> accepts = object(fields.get("accepts"));
      return new RouteGate.QueryRule(key, switch (text(accepts.get("tag"))) {
        case "AnyValue" -> RouteGate.Accept.ANY;
        case "Matching" -> new RouteGate.Accept(RouteGate.AcceptKind.MATCHING, text(accepts.get("pattern")));
        case "Pinned" -> new RouteGate.Accept(RouteGate.AcceptKind.PINNED, text(accepts.get("value")));
        default -> throw new IllegalArgumentException("not a query rule");
      });
    });
    Map<String, Object> limit = object(route.get("limit"));
    Long bytes = switch (text(limit.get("tag"))) {
      case "AnySize" -> null;
      case "AtMost" -> whole(limit.get("bytes"));
      default -> throw new IllegalArgumentException("not a body limit");
    };
    return new RouteGate.Route(method, delivery, path, query, bytes);
  }

  private static RouteGate.Request request(Object value) {
    Map<String, Object> request = object(value);
    RouteGate.Method method = named(RouteGate.Method.values(), request.get("method"));
    RouteGate.Delivery delivery = named(RouteGate.Delivery.values(), request.get("delivery"));
    List<RouteGate.Segment> segments = list(request.get("segments"), segment -> {
      Map<String, Object> fields = object(segment);
      return new RouteGate.Segment(text(fields.get("text")), list(fields.get("fits"), ChannelAdapter::text));
    });
    List<RouteGate.QueryPair> query = list(request.get("query"), pair -> {
      Map<String, Object> fields = object(pair);
      return new RouteGate.QueryPair(text(fields.get("key")), text(fields.get("value")), list(fields.get("fits"), ChannelAdapter::text));
    });
    List<RouteGate.Flaw> flaws = list(request.get("flaws"), flaw -> named(RouteGate.Flaw.values(), flaw));
    Map<String, Object> body = object(request.get("body"));
    RouteGate.Body decoded = switch (text(body.get("tag"))) {
      case "NoBody" -> RouteGate.Body.NONE;
      case "JsonObject" -> new RouteGate.Body(RouteGate.BodyKind.JSON_OBJECT, whole(body.get("size")));
      case "NotAnObject" -> RouteGate.Body.NOT_AN_OBJECT;
      default -> throw new IllegalArgumentException("not a body");
    };
    return new RouteGate.Request(method, delivery, segments, query, flaws, decoded);
  }

  private static ChannelPolicy.Header header(Object value) {
    Map<String, Object> header = object(value);
    if (!(header.get("printable") instanceof Boolean printable)) throw new IllegalArgumentException("expected a boolean");
    return new ChannelPolicy.Header(text(header.get("key")), named(ChannelPolicy.HeaderName.values(), header.get("name")), whole(header.get("bytes")), printable);
  }

  private static ChannelPolicy.Frame frame(Object value) {
    Map<String, Object> frame = object(value);
    ChannelPolicy.FrameKind kind = named(ChannelPolicy.FrameKind.values(), frame.get("tag"));
    return switch (kind) {
      case RESULT -> new ChannelPolicy.Frame(kind, whole(frame.get("status")));
      case HEAD -> new ChannelPolicy.Frame(kind, whole(frame.get("code")));
      default -> ChannelPolicy.Frame.of(kind);
    };
  }

  private String state() {
    String launch = policy.serving() ? "{\"tag\":\"Serving\",\"epoch\":" + policy.servingEpoch() + "}" : "{\"tag\":\"NotServing\"}";
    List<String> pending = new ArrayList<>();
    for (ChannelPolicy.Entry entry : policy.pending())
      pending.add("{\"seq\":" + entry.seq() + ",\"id\":" + quote(entry.id()) + ",\"owner\":" + quote(entry.owner()) + ",\"mode\":" + mode(entry.mode())
        + ",\"epoch\":" + entry.epoch() + ",\"delivered\":" + entry.delivered() + "}");
    return "{\"renderer\":" + gate(policy.gate(ChannelPolicy.CallerKind.RENDERER)) + ",\"native\":" + gate(policy.gate(ChannelPolicy.CallerKind.NATIVE))
      + ",\"launch\":" + launch + ",\"lastEpoch\":" + policy.lastEpoch() + ",\"rootToken\":" + quote(policy.rootToken()) + ",\"nextSeq\":" + policy.nextSeq()
      + ",\"pending\":[" + String.join(",", pending) + "],\"recent\":" + outs(policy.recent()) + "}";
  }

  private static String gate(RouteGate gate) {
    String table = switch (gate.table()) {
      case UNLOADED -> "{\"tag\":\"Unloaded\"}";
      case REFUSED -> "{\"tag\":\"Refused\"}";
      case LOADED -> {
        List<String> groups = new ArrayList<>();
        for (RouteGate.Group group : gate.served()) {
          List<String> prefixes = new ArrayList<>(), routes = new ArrayList<>();
          for (List<String> prefix : group.prefixes()) prefixes.add("[" + String.join(",", prefix.stream().map(ChannelAdapter::quote).toList()) + "]");
          for (RouteGate.Route route : group.routes()) routes.add(route(route));
          groups.add("{\"prefixes\":[" + String.join(",", prefixes) + "],\"id\":" + quote(group.id()) + ",\"routes\":[" + String.join(",", routes) + "]}");
        }
        yield "{\"tag\":\"Loaded\",\"groups\":[" + String.join(",", groups) + "]}";
      }
    };
    return "{\"table\":" + table + ",\"answer\":{\"tag\":\"Unanswered\"}}";
  }

  private static String route(RouteGate.Route route) {
    List<String> path = new ArrayList<>(), query = new ArrayList<>();
    for (RouteGate.Piece piece : route.path()) path.add(piece.isParam() ? "{\"tag\":\"Param\"}" : "{\"tag\":\"Literal\",\"text\":" + quote(piece.literal()) + "}");
    for (RouteGate.QueryRule rule : route.query()) {
      String accepts = switch (rule.accepts().kind()) {
        case ANY_VALUE -> "{\"tag\":\"AnyValue\"}";
        case MATCHING -> "{\"tag\":\"Matching\",\"pattern\":" + quote(rule.accepts().text()) + "}";
        case PINNED -> "{\"tag\":\"Pinned\",\"value\":" + quote(rule.accepts().text()) + "}";
      };
      query.add("{\"key\":" + quote(rule.key()) + ",\"accepts\":" + accepts + "}");
    }
    String limit = route.limit() == null ? "{\"tag\":\"AnySize\"}" : "{\"tag\":\"AtMost\",\"bytes\":" + route.limit() + "}";
    return "{\"method\":" + quote(tag(route.method())) + ",\"delivery\":" + quote(tag(route.delivery())) + ",\"path\":[" + String.join(",", path)
      + "],\"query\":[" + String.join(",", query) + "],\"limit\":" + limit + "}";
  }

  private static String outs(List<ChannelPolicy.Out> outs) {
    List<String> written = new ArrayList<>();
    for (ChannelPolicy.Out out : outs) {
      if (out instanceof ChannelPolicy.Refused refused)
        written.add("{\"tag\":\"Refused\",\"id\":" + quote(refused.id()) + ",\"code\":" + quote(tag(refused.code())) + "}");
      else if (out instanceof ChannelPolicy.Accepted accepted)
        written.add("{\"tag\":\"Accepted\",\"id\":" + quote(accepted.id()) + ",\"seq\":" + accepted.seq() + "}");
      else if (out instanceof ChannelPolicy.Delivered delivered)
        written.add("{\"tag\":\"Delivered\",\"id\":" + quote(delivered.id()) + ",\"seq\":" + delivered.seq() + ",\"index\":" + delivered.index() + "}");
      else if (out instanceof ChannelPolicy.Settled settled)
        written.add("{\"tag\":\"Settled\",\"id\":" + quote(settled.id()) + ",\"seq\":" + settled.seq() + ",\"mode\":" + mode(settled.mode()) + ",\"outcome\":" + outcome(settled.outcome()) + "}");
    }
    return "[" + String.join(",", written) + "]";
  }

  private static String mode(ChannelPolicy.Mode mode) {
    return mode.kind() == ChannelPolicy.ModeKind.WATCH
      ? "{\"tag\":\"Watch\",\"topic\":" + quote(tag(mode.topic())) + "}"
      : "{\"tag\":" + quote(tag(mode.kind())) + "}";
  }

  private static String outcome(ChannelPolicy.Outcome outcome) {
    return switch (outcome.kind()) {
      case RESPONSE -> "{\"tag\":\"Response\",\"status\":" + outcome.status() + "}";
      case FAILED -> "{\"tag\":\"Failed\",\"code\":" + quote(tag(outcome.code())) + "}";
      default -> "{\"tag\":" + quote(tag(outcome.kind())) + "}";
    };
  }

  private static String tag(Enum<?> value) {
    StringBuilder out = new StringBuilder();
    for (String word : value.name().split("_")) out.append(word.charAt(0)).append(word.substring(1).toLowerCase(Locale.ROOT));
    return out.toString();
  }

  private static <E extends Enum<E>> E named(E[] values, Object value) {
    String wanted = text(value);
    for (E candidate : values) if (tag(candidate).equals(wanted)) return candidate;
    throw new IllegalArgumentException("unknown name " + wanted);
  }

  private static <T> List<T> list(Object value, Function<Object, T> item) {
    if (!(value instanceof List<?> items)) throw new IllegalArgumentException("expected an array");
    List<T> decoded = new ArrayList<>();
    for (Object element : items) decoded.add(item.apply(element));
    return decoded;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> object(Object value) {
    if (value instanceof Map<?, ?> map) return (Map<String, Object>) map;
    throw new IllegalArgumentException("expected an object");
  }

  private static String text(Object value) {
    if (value instanceof String text) return text;
    throw new IllegalArgumentException("expected text");
  }

  private static long whole(Object value) {
    if (!(value instanceof BigDecimal number) || number.stripTrailingZeros().scale() > 0 || number.abs().compareTo(SAFE) > 0)
      throw new IllegalArgumentException("expected a safe whole number");
    return number.longValueExact();
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (int at = 0; at < text.length(); at++) {
      char c = text.charAt(at);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }
}
