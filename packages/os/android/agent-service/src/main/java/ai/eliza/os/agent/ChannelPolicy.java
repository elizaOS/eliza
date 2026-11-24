// spec/os/agentService/channel.md, "A call is refused before any I/O unless the agent is serving, its id is free and its list admits it"; spec/os/agentService/channel.md, "The token is written only to a socket whose peer is this app"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/agent/client/runtimeClient.md, "A request carries only device headers and the client id, a bounded few"; spec/os/agentService/channel.md, "A pending call settles exactly once, and nothing else leaves the pending list"; spec/os/agentService/channel.md, "At most one subscription per topic is open, and no more than the agent serves at once"
package ai.eliza.os.agent;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ChannelPolicy {
  public static final int FEED_LIMIT = 2;
  public static final int HEADER_COUNT_LIMIT = 16, HEADER_BYTES_LIMIT = 8192;
  private static final Pattern HEADER_NAME = Pattern.compile("^[A-Za-z0-9-]+$");
  private static final Pattern DEVICE_HEADER = Pattern.compile("^x-eliza-device-(?:[a-z0-9]+-)*([a-z0-9]+)$");
  private static final Pattern PRINTABLE = Pattern.compile("^[\\x20-\\x7e]*$");
  private static final Set<String> CREDENTIAL_WORDS = Set.of("key", "token", "secret", "password", "signature");
  private static final Pattern ENROLLMENT_KEY = Pattern.compile("^[a-f0-9]{64}$");

  /** Whether the agent socket's peer may be written to. {@code peerUid} is the user id the kernel reports, or null when it could not be read. */
  public static boolean peerTrusted(Integer peerUid, int appUid) { return peerUid != null && peerUid == appUid; }

  public enum CallerKind { RENDERER, NATIVE }
  public enum Topic { VOICE, VIEW, NOTICES }
  public enum FailCode { NOT_READY, ROUTE_REFUSED, TOO_LARGE, ID_IN_USE, TOPIC_IN_USE, BUSY, RESTARTED, BROKEN }
  public enum ModeKind { PLAIN, STREAM, WATCH }
  public enum OutcomeKind { RESPONSE, END, ERROR, ABORTED, FAILED }
  public enum FrameKind { RESULT, REFUSAL, HEAD, CHUNK, COMPLETE, COMPLETE_FAILED, SUBSCRIBED, AGENT_EVENT }
  public enum HeaderName { DEVICE_FACT, ENROLLMENT_KEY, DEVICE_CREDENTIAL, CLIENT_ID_HEADER, OTHER_HEADER }

  public record Header(String key, HeaderName name, long bytes, boolean printable) {}

  public record Mode(ModeKind kind, Topic topic) {
    public static final Mode PLAIN = new Mode(ModeKind.PLAIN, null), STREAM = new Mode(ModeKind.STREAM, null);
    public static Mode watch(Topic topic) { return new Mode(ModeKind.WATCH, topic); }
  }
  public record Outcome(OutcomeKind kind, long status, FailCode code) {
    public static final Outcome END = new Outcome(OutcomeKind.END, 0, null), ERROR = new Outcome(OutcomeKind.ERROR, 0, null), ABORTED = new Outcome(OutcomeKind.ABORTED, 0, null);
    public static Outcome response(long status) { return new Outcome(OutcomeKind.RESPONSE, status, null); }
    public static Outcome failed(FailCode code) { return new Outcome(OutcomeKind.FAILED, 0, code); }
  }
  public record Frame(FrameKind kind, long number) {
    public static Frame of(FrameKind kind) { return new Frame(kind, 0); }
  }
  public record Entry(long seq, String id, String owner, Mode mode, long epoch, long delivered) {}

  public sealed interface Out permits Refused, Accepted, Delivered, Settled {}
  public record Refused(String id, FailCode code) implements Out {}
  public record Accepted(String id, long seq) implements Out {}
  public record Delivered(String id, long seq, long index) implements Out {}
  public record Settled(String id, long seq, Mode mode, Outcome outcome) implements Out {}

  public record Step(boolean allowed, List<Out> out) {
    static final Step REFUSED = new Step(false, List.of()), QUIET = new Step(true, List.of());
  }

  private final RouteGate renderer = new RouteGate(), nativeGate = new RouteGate();
  private boolean serving;
  private long lastEpoch, nextSeq;
  private String rootToken = "";
  private final List<Entry> pending = new ArrayList<>();
  private List<Out> recent = List.of();

  public RouteGate gate(CallerKind kind) { return kind == CallerKind.RENDERER ? renderer : nativeGate; }

  public synchronized boolean loadRoutes(CallerKind kind, List<RouteGate.Group> routes) { return gate(kind).load(routes); }

  public synchronized boolean loadRouteTable(CallerKind kind, String json) { return gate(kind).loadWire(json); }

  public synchronized boolean serving() { return serving; }

  public synchronized long servingEpoch() { return serving ? lastEpoch : 0; }

  public synchronized long lastEpoch() { return lastEpoch; }

  public synchronized long nextSeq() { return nextSeq; }

  public synchronized List<Entry> pending() { return List.copyOf(pending); }

  public synchronized List<Out> recent() { return recent; }

  synchronized String rootToken() { return rootToken; }

  public synchronized Step open(long epoch, String token) {
    if (serving || epoch <= lastEpoch) return Step.REFUSED;
    serving = true;
    lastEpoch = epoch;
    rootToken = token;
    recent = List.of();
    return Step.QUIET;
  }

  public synchronized Step retire(long epoch) {
    if (!serving || lastEpoch != epoch) return Step.REFUSED;
    List<Out> out = new ArrayList<>();
    for (Entry entry : pending) out.add(settled(entry, Outcome.failed(FailCode.RESTARTED)));
    pending.clear();
    serving = false;
    rootToken = "";
    return emit(out);
  }

  public synchronized Step ask(CallerKind kind, String owner, String id, String method, String target, boolean streamed, byte[] body, List<Header> headers) {
    return ask(kind, owner, id, gate(kind).request(method, target, streamed, body), headers);
  }

  public synchronized Step ask(CallerKind kind, String owner, String id, RouteGate.Request request, List<Header> headers) {
    RouteGate.Admission admission = gate(kind).admit(request);
    FailCode refusal = !serving ? FailCode.NOT_READY
      : idTaken(id) ? FailCode.ID_IN_USE
      : admission.verdict() == RouteGate.Verdict.ROUTE_REFUSED ? FailCode.ROUTE_REFUSED
      : admission.verdict() == RouteGate.Verdict.TOO_LARGE ? FailCode.TOO_LARGE
      : headerRefusal(headers);
    if (refusal != null) return emit(List.of(new Refused(id, refusal)));
    return admitEntry(id, owner, request.delivery() == RouteGate.Delivery.STREAMED ? Mode.STREAM : Mode.PLAIN);
  }

  public static List<Header> headers(Map<String, ?> raw) {
    List<Header> described = new ArrayList<>(raw.size());
    raw.forEach((name, value) -> {
      String key = keyOf(name);
      String text = value instanceof String plain ? plain : null;
      long bytes = key.getBytes(StandardCharsets.UTF_8).length + (text == null ? 0 : text.getBytes(StandardCharsets.UTF_8).length);
      described.add(new Header(key, headerName(key, text), bytes, text != null && PRINTABLE.matcher(text).matches()));
    });
    return described;
  }

  public static Map<String, String> carried(Map<String, ?> raw) {
    Map<String, String> sent = new LinkedHashMap<>();
    raw.forEach((name, value) -> sent.put(keyOf(name), String.valueOf(value)));
    return sent;
  }

  private static String keyOf(String name) {
    return HEADER_NAME.matcher(name).matches() ? name.toLowerCase(Locale.ROOT) : name;
  }

  private static HeaderName headerName(String key, String value) {
    if (key.equals("x-elizaos-client-id")) return HeaderName.CLIENT_ID_HEADER;
    if (key.equals("x-eliza-device-key") && value != null && ENROLLMENT_KEY.matcher(value).matches()) return HeaderName.ENROLLMENT_KEY;
    Matcher device = DEVICE_HEADER.matcher(key);
    if (!device.matches()) return HeaderName.OTHER_HEADER;
    return CREDENTIAL_WORDS.contains(device.group(1)) ? HeaderName.DEVICE_CREDENTIAL : HeaderName.DEVICE_FACT;
  }

  private static FailCode headerRefusal(List<Header> headers) {
    long bytes = 0;
    for (Header header : headers) {
      boolean crosses = header.printable() && (header.name() == HeaderName.DEVICE_FACT || header.name() == HeaderName.ENROLLMENT_KEY
        || header.name() == HeaderName.CLIENT_ID_HEADER);
      if (!crosses || headers.stream().filter(other -> other.key().equals(header.key())).count() != 1) return FailCode.ROUTE_REFUSED;
      bytes += header.bytes();
    }
    return headers.size() > HEADER_COUNT_LIMIT || bytes > HEADER_BYTES_LIMIT ? FailCode.TOO_LARGE : null;
  }

  public synchronized Step subscribe(String owner, String id, Topic topic) {
    Mode mode = Mode.watch(topic);
    FailCode refusal = !serving ? FailCode.NOT_READY
      : idTaken(id) ? FailCode.ID_IN_USE
      : pending.stream().anyMatch(entry -> entry.mode().equals(mode)) ? FailCode.TOPIC_IN_USE
      : pending.stream().filter(entry -> entry.mode().kind() == ModeKind.WATCH).count() >= FEED_LIMIT ? FailCode.BUSY
      : null;
    if (refusal != null) return emit(List.of(new Refused(id, refusal)));
    return admitEntry(id, owner, mode);
  }

  private Step admitEntry(String id, String owner, Mode mode) {
    long seq = nextSeq++;
    pending.add(new Entry(seq, id, owner, mode, servingEpoch(), 0));
    return emit(List.of(new Accepted(id, seq)));
  }

  public synchronized Step reply(long seq, Frame frame) {
    Entry entry = entryAt(seq);
    if (entry == null) return Step.QUIET;
    return switch (entry.mode().kind()) {
      case PLAIN -> settle(entry, frame.kind() == FrameKind.RESULT ? Outcome.response(frame.number()) : Outcome.failed(FailCode.BROKEN));
      case STREAM -> switch (frame.kind()) {
        case HEAD, CHUNK -> deliver(entry);
        case COMPLETE -> settle(entry, Outcome.END);
        default -> settle(entry, Outcome.ERROR);
      };
      case WATCH -> switch (frame.kind()) {
        case AGENT_EVENT -> deliver(entry);
        case SUBSCRIBED -> Step.QUIET;
        default -> settle(entry, Outcome.END);
      };
    };
  }

  public synchronized Step lost(long seq) {
    Entry entry = entryAt(seq);
    if (entry == null) return Step.QUIET;
    return settle(entry, switch (entry.mode().kind()) {
      case PLAIN -> Outcome.failed(FailCode.BROKEN);
      case STREAM -> Outcome.ERROR;
      case WATCH -> Outcome.END;
    });
  }

  public synchronized Step abort(String owner, String id) {
    for (Entry entry : pending)
      if (entry.id().equals(id) && entry.owner().equals(owner))
        return settle(entry, entry.mode().kind() == ModeKind.WATCH ? Outcome.END : Outcome.ABORTED);
    return Step.REFUSED;
  }

  public synchronized Entry entryAt(long seq) {
    for (Entry entry : pending) if (entry.seq() == seq) return entry;
    return null;
  }

  private boolean idTaken(String id) {
    return id == null || id.isEmpty() || pending.stream().anyMatch(entry -> entry.id().equals(id));
  }

  private Step deliver(Entry entry) {
    Entry next = new Entry(entry.seq(), entry.id(), entry.owner(), entry.mode(), entry.epoch(), entry.delivered() + 1);
    pending.set(pending.indexOf(entry), next);
    return emit(List.of(new Delivered(entry.id(), entry.seq(), next.delivered())));
  }

  private Step settle(Entry entry, Outcome outcome) {
    pending.remove(entry);
    return emit(List.of(settled(entry, outcome)));
  }

  private static Settled settled(Entry entry, Outcome outcome) {
    return new Settled(entry.id(), entry.seq(), entry.mode(), outcome);
  }

  private Step emit(List<Out> out) {
    recent = List.copyOf(out);
    return new Step(true, recent);
  }
}
