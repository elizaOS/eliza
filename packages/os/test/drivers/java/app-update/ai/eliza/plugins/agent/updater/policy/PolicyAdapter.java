// spec/os/appUpdate/policy.md, "Story: Update my apps only when it is safe and on time"
package ai.eliza.plugins.agent.updater.policy;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

public final class PolicyAdapter {
  private static final long SAFE = 9_007_199_254_740_991L;
  private static final long MINUTE = OtaPolicy.MINUTE;
  private static final Map<String, String> SIGNALS = Map.ofEntries(
    Map.entry("charging", "Charging"), Map.entry("battery", "Battery"), Map.entry("thermal", "Thermal"), Map.entry("idle", "Idle"),
    Map.entry("call", "Call"), Map.entry("media", "Media"), Map.entry("camera", "Camera"), Map.entry("recording", "Recording"),
    Map.entry("cast", "Cast"), Map.entry("navigation", "Navigation"), Map.entry("critical-task", "CriticalTask"),
    Map.entry("window", "Comfort"), Map.entry("alarm", "Alarm"), Map.entry("network", "Connectivity"));
  private static final Map<String, String> UNMET = Map.of(
    "not-charging", "Charging", "thermal-unsafe", "Thermal", "not-idle", "Idle", "outside-window", "Comfort", "no-qualified-reboot-route", "RebootRoute");
  private static final Map<String, String> REASONS = Map.of(
    "activation-deferred-72h", "ActivationLate", "activation-deferred-7d", "ActivationOverdue", "checks-missing-72h", "ChecksLate",
    "checks-missing-7d", "ChecksOverdue", "policy-state-reset", "StateReset", "signed-time-unavailable", "SignedTimeMissing", "policy-state-unsaved", "StateUnsaved");
  private static final Map<String, String> RESULTS = Map.of(
    "checked", "DiscoveryChecked", "transfer_queued", "TransferQueued", "unavailable", "SourceUnavailable",
    "not_enabled", "NotEnabled", "started", "ActivationStarted", "failed", "ActivationFailed");

  private Path directory;
  private PolicyStore store;

  private record Run(PolicyEngine.Job job, long signedLower, long wall, DeviceSignals signals, PolicyEngine.Discovery.Result found,
    Map<String, Object> pending, PolicyEngine.Activation.Outcome activated, long jitter, String ending) {}

  public static void main(String[] args) throws Exception {
    PolicyAdapter adapter = new PolicyAdapter();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    try {
      for (String line; (line = input.readLine()) != null;) {
        if (line.isBlank()) continue;
        try { output.println(adapter.answer(line)); }
        catch (RuntimeException | IOException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
      }
    } finally {
      adapter.discard();
    }
  }

  private String answer(String line) throws IOException {
    Map<String, Object> request = object(new Json(line).value());
    if (!request.containsKey("event") && !request.containsKey("raw")) {
      discard();
      directory = Files.createTempDirectory("app-update-policy-");
      store = new PolicyStore(directory.resolve("policy.properties"));
      return "{\"state\":" + ledger(store.load()) + ",\"out\":[]}";
    }
    Object event = request.containsKey("event") ? request.get("event") : request.get("raw");
    Map<String, Object> fields = event instanceof Map<?, ?> ? object(event) : Map.of();
    Object type = fields.get("type");
    Run run = null;
    if ("runJob".equals(type)) {
      try { run = decode(fields); }
      catch (IllegalArgumentException | ArithmeticException malformed) { run = null; }
    }
    List<String> out = List.of();
    String outcome = "accepted";
    if ("replaceUnreadable".equals(type)) Files.writeString(store.file(), "version=unreadable\n", StandardCharsets.UTF_8);
    else if (run != null) out = run(run);
    else outcome = "refused";
    return "{\"outcome\":\"" + outcome + "\",\"state\":" + ledger(store.load()) + ",\"out\":[" + String.join(",", out) + "]}";
  }

  private List<String> run(Run run) throws IOException {
    Path blocked = store.file().resolveSibling(store.file().getFileName() + ".tmp");
    if (run.ending().equals("Unsaved")) Files.createDirectories(blocked.resolve("held"));
    ZonedDateTime local = ZonedDateTime.ofInstant(Instant.ofEpochMilli(Math.multiplyExact(run.wall(), MINUTE)), ZoneOffset.UTC);
    long signed = Math.multiplyExact(run.signedLower(), MINUTE);
    PolicyEngine engine = new PolicyEngine(OtaPolicy.DEFAULTS, store,
      () -> signed, () -> local, () -> run.signals(), permitted -> run.found(),
      () -> pendingId(run.pending()), prepared -> run.activated(), bound -> run.jitter() * MINUTE,
      () -> run.ending().equals("Cancelled"));
    try {
      return List.of(plan(engine.run(run.job())));
    } catch (IOException cancelled) {
      if (!run.ending().equals("Cancelled")) throw cancelled;
      return List.of();
    } finally {
      if (Files.exists(blocked)) delete(blocked);
    }
  }

  private static String pendingId(Map<String, Object> reading) throws IOException {
    return switch (text(reading.get("tag"))) {
      case "NothingPending" -> null;
      case "PendingUnreadable" -> throw new IOException("the installation journal could not be read");
      case "Prepared" -> {
        long plan = whole(reading.get("preparedPlan"));
        yield plan > 0 ? Long.toString(plan) : "plan " + plan;
      }
      default -> throw new IllegalArgumentException("not a pending reading");
    };
  }

  private static Run decode(Map<String, Object> event) {
    PolicyEngine.Job job = switch (text(event.get("job"))) {
      case "DiscoveryJob" -> PolicyEngine.Job.DISCOVERY;
      case "DownloadJob" -> PolicyEngine.Job.DOWNLOAD;
      case "ActivationJob" -> PolicyEngine.Job.ACTIVATION;
      default -> throw new IllegalArgumentException("not a job");
    };
    PolicyEngine.Discovery.Result found = switch (text(event.get("found"))) {
      case "DiscoveryChecked" -> PolicyEngine.Discovery.Result.CHECKED;
      case "TransferQueued" -> PolicyEngine.Discovery.Result.TRANSFER_QUEUED;
      case "SourceUnavailable" -> PolicyEngine.Discovery.Result.UNAVAILABLE;
      default -> throw new IllegalArgumentException("not a discovery result");
    };
    PolicyEngine.Activation.Outcome activated = switch (text(event.get("activated"))) {
      case "NotEnabled" -> PolicyEngine.Activation.Outcome.NOT_ENABLED;
      case "ActivationStarted" -> PolicyEngine.Activation.Outcome.STARTED;
      case "ActivationFailed" -> PolicyEngine.Activation.Outcome.FAILED;
      default -> throw new IllegalArgumentException("not an activation result");
    };
    String ending = text(event.get("ending"));
    if (!List.of("Saved", "Unsaved", "Cancelled").contains(ending)) throw new IllegalArgumentException("not a run ending");
    Map<String, Object> pending = object(event.get("pending"));
    String reading = text(pending.get("tag"));
    if (reading.equals("Prepared")) whole(pending.get("preparedPlan"));
    else if (!reading.equals("NothingPending") && !reading.equals("PendingUnreadable")) throw new IllegalArgumentException("not a pending reading");
    long wall = whole(event.get("wall")), jitter = whole(event.get("jitter")), signed = whole(event.get("signedLower"));
    DeviceSignals signals = signals(object(event.get("signals")));
    if (wall < 0 || jitter < 0 || jitter * MINUTE >= 2 * OtaPolicy.DEFAULTS.discoveryJitterMillis + 1) return null;
    return new Run(job, signed, wall, signals, found, pending, activated, jitter, ending);
  }

  private static DeviceSignals signals(Map<String, Object> s) {
    DeviceSignals.Builder b = new DeviceSignals.Builder()
      .charging(flag(s.get("charging"))).call(flag(s.get("call"))).media(flag(s.get("media"))).camera(flag(s.get("camera")))
      .recording(flag(s.get("recording"))).cast(flag(s.get("cast"))).navigation(flag(s.get("navigation"))).criticalTask(flag(s.get("criticalTask")));
    Long battery = gauge(s.get("battery")), thermal = gauge(s.get("thermal")), idle = gauge(s.get("idle"));
    b.batteryPercent(battery == null ? null : (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, battery)));
    b.thermalStatus(thermal == null ? null : (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, thermal)));
    b.idleMillis(idle == null ? null : Math.multiplyExact(idle, MINUTE));
    b.network(switch (text(s.get("network"))) {
      case "NetUnmetered" -> DeviceSignals.Network.UNMETERED;
      case "NetMetered" -> DeviceSignals.Network.METERED;
      case "NetNone" -> DeviceSignals.Network.NONE;
      case "NetUnknown" -> DeviceSignals.Network.UNKNOWN;
      default -> throw new IllegalArgumentException("not a network");
    });
    Map<String, Object> alarm = object(s.get("nextAlarm"));
    b.nextAlarmInMillis(switch (text(alarm.get("tag"))) {
      case "AlarmUnread" -> null;
      case "NoAlarmSet" -> DeviceSignals.NO_ALARM;
      case "AlarmIn" -> Math.multiplyExact(whole(alarm.get("alarmMinutes")), MINUTE);
      default -> throw new IllegalArgumentException("not an alarm reading");
    });
    return b.build();
  }

  private static Boolean flag(Object value) {
    return switch (text(value)) {
      case "FlagUnknown" -> null;
      case "FlagSet" -> Boolean.TRUE;
      case "FlagClear" -> Boolean.FALSE;
      default -> throw new IllegalArgumentException("not a flag");
    };
  }

  private static Long gauge(Object value) {
    Map<String, Object> gauge = object(value);
    return switch (text(gauge.get("tag"))) {
      case "GaugeUnknown" -> null;
      case "GaugeAt" -> whole(gauge.get("value"));
      default -> throw new IllegalArgumentException("not a gauge");
    };
  }

  private static String ledger(PolicyLedger l) {
    return "{\"trackingSince\":" + minutes(l.trackingSince) + ",\"lastCheck\":" + minutes(l.lastCheck)
      + ",\"pending\":" + (l.pendingId.isEmpty() ? 0 : Long.parseLong(l.pendingId)) + ",\"pendingSince\":" + minutes(l.pendingSince)
      + ",\"pendingSinceWall\":" + minutes(l.pendingSinceWall) + ",\"windowsThroughWall\":" + minutes(l.windowsThroughWall)
      + ",\"missedWindows\":" + l.missedWindows + ",\"resetSince\":" + minutes(l.resetSince) + ",\"resetPending\":" + l.resetPending
      + ",\"alertLevel\":" + quote(level(l.alertLevel)) + ",\"alertReasons\":" + reasons(l.alertReasons.isEmpty() ? List.of() : List.of(l.alertReasons.split(",")))
      + ",\"lastOutcome\":" + outcome(l.lastOutcome)
      + ",\"lastDecision\":" + decision(l.lastDecision.isEmpty() ? null : l.lastDecision.equals("allowed") ? List.of() : List.of(l.lastDecision.split(","))) + "}";
  }

  private static String plan(PolicyEngine.Plan p) {
    String discovery = p.discoveryDelayMillis == null ? "{\"tag\":\"DiscoveryUnchanged\"}"
      : "{\"tag\":\"DiscoveryAfter\",\"discoveryDelay\":" + minutes(p.discoveryDelayMillis) + "}";
    String download = p.download == null ? "{\"tag\":\"DownloadUnchanged\"}" : !p.download ? "{\"tag\":\"DownloadCancelled\"}"
      : "{\"tag\":\"DownloadAfter\",\"downloadDelay\":" + minutes(p.downloadDelayMillis) + "}";
    String activation = p.activationDelayMillis == null ? "{\"tag\":\"ActivationCancelled\"}"
      : "{\"tag\":\"ActivationAfter\",\"activationDelay\":" + minutes(p.activationDelayMillis) + "}";
    String alert = "{\"level\":" + quote(level(p.alert.level)) + ",\"reasons\":" + reasons(p.alert.reasons) + ",\"current\":" + p.alert.current + "}";
    String job = switch (p.job) { case DISCOVERY -> "DiscoveryJob"; case DOWNLOAD -> "DownloadJob"; case ACTIVATION -> "ActivationJob"; };
    return "{\"job\":" + quote(job) + ",\"discovery\":" + discovery + ",\"download\":" + download + ",\"activation\":" + activation
      + ",\"alert\":" + alert + ",\"decision\":" + decision(p.decision == null ? null : p.decision.blockers) + ",\"runOutcome\":" + outcome(p.outcome) + "}";
  }

  private static String decision(List<String> blockers) {
    if (blockers == null) return "{\"tag\":\"Undecided\"}";
    List<String> written = new ArrayList<>();
    for (String blocker : blockers) written.add(blocker(blocker));
    return "{\"tag\":\"Decided\",\"blockers\":[" + String.join(",", written) + "]}";
  }

  private static String blocker(String name) {
    switch (name) {
      case "pending-unknown": return "{\"tag\":\"PendingUnknown\"}";
      case "signed-time-unavailable": return "{\"tag\":\"SignedTimeUnavailable\"}";
      case "network-metered": return "{\"tag\":\"NetworkMetered\"}";
      case "network-none": return "{\"tag\":\"NetworkNone\"}";
      case "activation-not-enabled": return "{\"tag\":\"ActivationNotEnabled\"}";
      default:
    }
    if (UNMET.containsKey(name)) return signal("SignalUnmet", UNMET.get(name));
    if (name.startsWith("battery-below-")) return signal("SignalUnmet", "Battery");
    if (name.startsWith("alarm-within-")) return signal("SignalUnmet", "Alarm");
    int dash = name.lastIndexOf('-');
    String named = dash > 0 ? SIGNALS.get(name.substring(0, dash)) : null;
    if (named != null && name.endsWith("-unknown")) return signal("SignalUnknown", named);
    if (named != null && name.endsWith("-active")) return signal("SignalUnmet", named);
    throw new IllegalStateException("the gates named an unknown blocker " + name);
  }

  private static String signal(String tag, String signal) { return "{\"tag\":\"" + tag + "\",\"signal\":\"" + signal + "\"}"; }

  private static String outcome(String name) {
    switch (name) {
      case "": return "{\"tag\":\"NoOutcome\"}";
      case "discovery-deferred-signed-time-unavailable": return "{\"tag\":\"DiscoveryDeferred\"}";
      case "download-deferred": return "{\"tag\":\"DownloadDeferred\"}";
      case "no-pending-activation": return "{\"tag\":\"NoPendingActivation\"}";
      case "activation-deferred": return "{\"tag\":\"ActivationDeferred\"}";
      default:
    }
    int dash = name.indexOf('-');
    String result = dash > 0 ? RESULTS.get(name.substring(dash + 1)) : null;
    if (result != null) switch (name.substring(0, dash)) {
      case "discovery": return "{\"tag\":\"Discovered\",\"discovered\":\"" + result + "\"}";
      case "download": return "{\"tag\":\"Downloaded\",\"downloaded\":\"" + result + "\"}";
      case "activation": return "{\"tag\":\"Activated\",\"activation\":\"" + result + "\"}";
      default:
    }
    throw new IllegalStateException("the engine recorded an unknown outcome " + name);
  }

  private static String reasons(List<String> names) {
    List<String> written = new ArrayList<>();
    for (String name : names) {
      String reason = REASONS.get(name);
      if (reason == null) throw new IllegalStateException("the ledger named an unknown alert reason " + name);
      written.add(quote(reason));
    }
    return "[" + String.join(",", written) + "]";
  }

  private static String level(PolicyLedger.Alert.Level level) {
    return switch (level) { case NONE -> "AlertNone"; case ALERT -> "AlertRaised"; case ESCALATE -> "AlertEscalated"; };
  }

  private static long minutes(long millis) {
    if (millis % MINUTE != 0) throw new IllegalStateException(millis + " ms is not a whole number of minutes");
    return millis / MINUTE;
  }

  private void discard() throws IOException {
    if (directory != null) delete(directory);
    directory = null;
  }

  private static void delete(Path path) throws IOException {
    try (Stream<Path> walk = Files.walk(path)) {
      for (Path each : walk.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(each);
    }
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
    if (value instanceof Long number && Math.abs(number) <= SAFE) return number;
    throw new IllegalArgumentException("expected a safe whole number");
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : text.toCharArray()) {
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        default -> { if (c < 0x20) out.append(String.format("\\u%04x", (int) c)); else out.append(c); }
      }
    }
    return out.append('"').toString();
  }

  private static final class Json {
    private final String text;
    private int at;

    Json(String text) { this.text = text; }

    Object value() {
      skip();
      char c = text.charAt(at);
      if (c == '{') {
        Map<String, Object> out = new LinkedHashMap<>();
        at++;
        skip();
        if (text.charAt(at) == '}') { at++; return out; }
        do {
          skip();
          if (!(value() instanceof String key)) throw new IllegalArgumentException("expected a key at " + at);
          skip();
          if (text.charAt(at++) != ':') throw new IllegalArgumentException("expected : at " + at);
          out.put(key, value());
          skip();
        } while (text.charAt(at++) == ',');
        if (text.charAt(at - 1) != '}') throw new IllegalArgumentException("malformed object at " + at);
        return out;
      }
      if (c == '[') {
        List<Object> out = new ArrayList<>();
        at++;
        skip();
        if (text.charAt(at) == ']') { at++; return out; }
        do { out.add(value()); skip(); } while (text.charAt(at++) == ',');
        if (text.charAt(at - 1) != ']') throw new IllegalArgumentException("malformed array at " + at);
        return out;
      }
      if (c == '"') {
        StringBuilder out = new StringBuilder();
        for (at++; text.charAt(at) != '"'; at++) {
          char ch = text.charAt(at);
          if (ch != '\\') { out.append(ch); continue; }
          char escaped = text.charAt(++at);
          switch (escaped) {
            case 'n' -> out.append('\n');
            case 't' -> out.append('\t');
            case 'r' -> out.append('\r');
            case 'b' -> out.append('\b');
            case 'f' -> out.append('\f');
            case 'u' -> { out.append((char) Integer.parseInt(text.substring(at + 1, at + 5), 16)); at += 4; }
            default -> out.append(escaped);
          }
        }
        at++;
        return out.toString();
      }
      if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
      if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
      if (text.startsWith("null", at)) { at += 4; return null; }
      int start = at;
      while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
      String number = text.substring(start, at);
      if (number.isEmpty()) throw new IllegalArgumentException("unexpected " + c + " at " + start);
      return number.matches("-?[0-9]{1,18}") ? (Object) Long.parseLong(number) : (Object) Double.parseDouble(number);
    }

    private void skip() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
  }
}
