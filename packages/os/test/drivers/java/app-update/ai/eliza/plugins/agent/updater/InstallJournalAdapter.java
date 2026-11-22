// spec/os/appUpdate/install.md, "Story: Install an app update without running the agent mid-install"; spec/os/appUpdate/install.md, "Story: Recover from an unhealthy update once"
package ai.eliza.plugins.agent.updater;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

public final class InstallJournalAdapter {
  private static final long INSTALL_BUDGET_MS = 10 * 60 * 1000L;

  private final Map<String, Long> artifacts = new HashMap<>();
  private final Map<Long, UpdateJournal.Snapshot> collectedAt = new HashMap<>();
  private final List<String> announced = new ArrayList<>();
  private final UpdateHoldPort holds = new UpdateHoldPort() {
    @Override public void hold(UpdateJournal.Identity target) { announced.add("{\"tag\":\"Hold\",\"target\":" + artifact(target.digest) + "}"); }
    @Override public boolean awaitHeld(UpdateJournal.Identity target, long timeoutMillis) { return true; }
    @Override public void release(UpdateJournal.Identity installed) { announced.add("{\"tag\":\"Release\",\"installed\":" + artifact(installed.digest) + "}"); }
  };
  private Path directory;
  private UpdateJournal journal;
  private Map<String, Object> staged;
  private long uptime;

  public static void main(String[] args) throws Exception {
    InstallJournalAdapter adapter = new InstallJournalAdapter();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    try {
      for (String line; (line = input.readLine()) != null;) {
        if (line.isBlank()) continue;
        try { output.println(adapter.answer(line)); }
        catch (Exception failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
      }
    } finally {
      adapter.discard();
    }
  }

  private void discard() throws IOException {
    if (directory == null) return;
    try (var walk = Files.walk(directory)) {
      for (Path entry : walk.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(entry);
    }
    directory = null;
  }

  private String answer(String line) throws IOException {
    Map<String, Object> request = object(Json.parse(line));
    if (!request.containsKey("event")) {
      discard();
      directory = Files.createTempDirectory("install-journal-");
      artifacts.clear();
      journal = new UpdateJournal(directory.resolve("journal"), path -> {}, holds);
      staged = null;
      uptime = 0;
      collectedAt.clear();
      UpdateJournal.Snapshot initial = journal.read();
      collectedAt.put(initial.revision, initial);
      return "{\"state\":" + state(initial) + ",\"out\":[]}";
    }
    announced.clear();
    boolean accepted;
    try { accepted = dispatch(object(request.get("event"))); }
    catch (IOException | IllegalArgumentException refused) { accepted = false; }
    UpdateJournal.Snapshot now = journal.read();
    collectedAt.put(now.revision, now);
    String out = accepted ? "[" + String.join(",", announced) + "]" : "[]";
    return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state(now) + ",\"out\":" + out + "}";
  }

  private boolean dispatch(Map<String, Object> event) throws IOException {
    UpdateJournal.Snapshot now = journal.read();
    String current = now.plan == null ? "" : now.plan.id;
    switch (text(event.get("type"))) {
      case "stage" -> {
        Map<String, Object> plan = object(event.get("plan"));
        boolean applied = journal.stageValidated(plan(plan, now.channel), identity(whole(event.get("installed"))), whole(plan.get("generation")), () -> {}).applied;
        staged = plan;
        return applied;
      }
      case "verify" -> {
        if (staged == null || !planId(whole(staged.get("id"))).equals(planId(whole(event.get("planId"))))) return false;
        UpdateJournal.Plan plan = plan(staged, now.channel);
        return journal.verifyStaged(plan, plan.baseline, whole(staged.get("generation")), () -> {}).applied;
      }
      case "dropPlan" -> {
        String plan = planId(whole(event.get("planId")));
        return now.phase == UpdateJournal.Phase.STAGING
          ? journal.discardStaging(plan, now.channelGeneration).applied
          : journal.discardVerified(plan, now.channelGeneration, "release-revoked").applied;
      }
      case "changeChannel" -> { return journal.setChannel("stable".equals(now.channel) ? "beta" : "stable").applied; }
      case "requestHold" -> { return journal.requestHold(current).applied; }
      case "acknowledgeHold" -> { return journal.acknowledgeHold(current, identity(whole(event.get("target")))).applied; }
      case "commitCandidate" -> {
        return journal.committingWithAction(current, session(event), now.channelGeneration, (plan, generation) -> {}, () -> {}).applied;
      }
      case "commitRecovery" -> { return journal.recoveringWithAction(current, session(event), () -> {}).applied; }
      case "denyRecovery" -> { return journal.recoveryUnavailable(current, "recovery-revoked").applied; }
      case "stallInstall" -> {
        int session = session(event);
        if (!journal.observePending(current, session, 0, tick(), INSTALL_BUDGET_MS).applied) return false;
        journal.observePending(current, session, 0, elapse(INSTALL_BUDGET_MS), INSTALL_BUDGET_MS);
        return true;
      }
      case "abandonUnknown" -> {
        if (!journal.observeOutcomeUnknown(current, now.sessionId, 0, tick()).applied) return false;
        journal.observeOutcomeUnknown(current, now.sessionId, 0, elapse(UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS));
        return true;
      }
      case "observeInstall" -> {
        Map<String, Object> readback = object(event.get("readback"));
        String status = text(readback.get("status"));
        String blocked = switch (status) {
          case "SessionBlocked" -> "user_action_required";
          case "SessionListed", "SessionGone" -> null;
          default -> throw new IllegalArgumentException("unknown session status " + status);
        };
        UpdateJournal.InstallerFailure report = switch (text(readback.get("report"))) {
          case "NoReport" -> null;
          case "Retryable" -> UpdateJournal.InstallerFailure.RETRYABLE;
          case "CandidateRejected" -> UpdateJournal.InstallerFailure.CANDIDATE_REJECTED;
          default -> throw new IllegalArgumentException("unknown installer report");
        };
        return journal.reconcileInstallerResult(planId(whole(readback.get("planId"))), Math.toIntExact(whole(readback.get("sessionId"))),
          identity(whole(readback.get("installed"))), !"SessionGone".equals(status), blocked, report).applied;
      }
      case "observeHealth" -> {
        Map<String, Object> evidence = object(event.get("evidence"));
        UpdateJournal.Snapshot observed = collectedAt.get(whole(evidence.get("revision")));
        if (observed != null && (observed.plan == null || !observed.plan.id.equals(planId(whole(evidence.get("planId"))))
            || observed.channelGeneration != whole(evidence.get("generation")))) observed = null;
        UpdateJournal.Identity installed = identity(whole(evidence.get("installed")));
        return switch (text(evidence.get("verdict"))) {
          case "HealthPassed" -> journal.installedHealthy(observed, installed).applied;
          case "HealthFailed" -> journal.localHealthFailed(observed, installed).applied;
          default -> throw new IllegalArgumentException("unknown health verdict");
        };
      }
      default -> throw new IllegalArgumentException("not an event of the install journal");
    }
  }

  private long tick() { return ++uptime; }

  private long elapse(long millis) { uptime += millis; return uptime; }

  private static int session(Map<String, Object> event) { return Math.toIntExact(whole(event.get("sessionId"))); }

  private static String planId(long id) { return "plan-" + id; }

  private UpdateJournal.Plan plan(Map<String, Object> plan, String channel) {
    return new UpdateJournal.Plan(planId(whole(plan.get("id"))), channel, "launcher",
      identity(whole(plan.get("baseline"))), identity(whole(plan.get("candidate"))), identity(whole(plan.get("recovery"))));
  }

  private UpdateJournal.Identity identity(long artifact) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(("artifact:" + artifact).getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder();
      for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
      artifacts.put(hex.toString(), artifact);
      return new UpdateJournal.Identity(artifact, hex.toString());
    } catch (java.security.NoSuchAlgorithmException missing) { throw new IllegalStateException(missing); }
  }

  private long artifact(String digest) {
    Long id = artifacts.get(digest);
    if (id == null) throw new IllegalStateException("an artifact the adapter never named: " + digest);
    return id;
  }

  private String state(UpdateJournal.Snapshot s) {
    String plan;
    if (s.plan == null) plan = "{\"id\":0,\"generation\":0,\"baseline\":0,\"candidate\":0,\"recovery\":0}";
    else {
      if (staged == null || !s.plan.id.equals(planId(whole(staged.get("id"))))) throw new IllegalStateException("the journal holds a plan the adapter did not stage");
      plan = "{\"id\":" + whole(staged.get("id")) + ",\"generation\":" + whole(staged.get("generation")) + ",\"baseline\":" + artifact(s.plan.baseline.digest)
        + ",\"candidate\":" + artifact(s.plan.candidate.digest) + ",\"recovery\":" + artifact(s.plan.recovery.digest) + "}";
    }
    TreeSet<Long> quarantine = new TreeSet<>();
    for (String digest : s.quarantine) quarantine.add(artifact(digest));
    List<String> quarantined = new ArrayList<>();
    for (long id : quarantine) quarantined.add(Long.toString(id));
    String reported = s.reportedFailure == null ? "NoReport" : switch (s.reportedFailure) {
      case RETRYABLE -> "Retryable";
      case CANDIDATE_REJECTED -> "CandidateRejected";
    };
    return "{\"phase\":" + quote(tag(s.phase)) + ",\"support\":" + quote(support(s)) + ",\"plan\":" + plan
      + ",\"session\":" + Math.max(0, s.sessionId) + ",\"recoveryAttempted\":" + (s.recoveryAttempts == 1) + ",\"hold\":" + quote(tag(s.hold))
      + ",\"generation\":" + s.channelGeneration + ",\"revision\":" + s.revision + ",\"quarantine\":[" + String.join(",", quarantined) + "]"
      + ",\"reported\":" + quote(reported) + ",\"releasedCandidate\":" + (s.releasedCandidate.isEmpty() ? 0 : artifact(s.releasedCandidate))
      + ",\"releases\":" + s.releases + "}";
  }

  private static String support(UpdateJournal.Snapshot s) {
    if (s.phase != UpdateJournal.Phase.SUPPORT) return "NoReason";
    return switch (s.reason) {
      case "user_action_required", "policy_blocked", "verification_failed" -> "InstallerBlocked";
      case "install_timeout", "install_clock_invalid" -> "InstallStalled";
      case UpdateJournal.OUTCOME_UNKNOWN -> "OutcomeUnknown";
      case "unexpected_installed_identity" -> "UnexpectedIdentity";
      case "recovery_install_failed", "local_health_failed" -> "RecoveryFailed";
      default -> throw new IllegalStateException("a support reason the spec does not name: " + s.reason);
    };
  }

  private static String tag(Enum<?> value) {
    StringBuilder out = new StringBuilder();
    for (String word : value.name().split("_")) out.append(word.charAt(0)).append(word.substring(1).toLowerCase(Locale.ROOT));
    return out.toString();
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
    if (value instanceof Long number) return number;
    throw new IllegalArgumentException("expected a whole number");
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : text.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c < 0x20) out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
      else out.append(c);
    }
    return out.append('"').toString();
  }

  private static final class Json {
    private final String text;
    private int at;

    private Json(String text) { this.text = text; }

    static Object parse(String text) {
      Json reader = new Json(text);
      Object value = reader.value();
      reader.space();
      if (reader.at != text.length()) throw new IllegalArgumentException("text after the JSON value");
      return value;
    }

    private void space() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }

    private char next() {
      space();
      if (at >= text.length()) throw new IllegalArgumentException("unexpected end of JSON");
      return text.charAt(at);
    }

    private Object value() {
      char c = next();
      if (c == '{') {
        Map<String, Object> object = new LinkedHashMap<>();
        at++;
        if (next() == '}') { at++; return object; }
        do {
          if (next() != '"') throw new IllegalArgumentException("expected a key at " + at);
          String key = string();
          if (next() != ':') throw new IllegalArgumentException("expected : at " + at);
          at++;
          object.put(key, value());
        } while (separated('}'));
        return object;
      }
      if (c == '[') {
        List<Object> array = new ArrayList<>();
        at++;
        if (next() == ']') { at++; return array; }
        do array.add(value()); while (separated(']'));
        return array;
      }
      if (c == '"') return string();
      if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
      if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
      if (text.startsWith("null", at)) { at += 4; return null; }
      int start = at;
      if (at < text.length() && text.charAt(at) == '-') at++;
      while (at < text.length() && Character.isDigit(text.charAt(at))) at++;
      if (start == at || (at < text.length() && ".eE".indexOf(text.charAt(at)) >= 0)) throw new IllegalArgumentException("expected a whole number at " + start);
      return Long.parseLong(text.substring(start, at));
    }

    private boolean separated(char close) {
      char c = next();
      at++;
      if (c == ',') return true;
      if (c == close) return false;
      throw new IllegalArgumentException("expected , or " + close + " at " + (at - 1));
    }

    private String string() {
      StringBuilder out = new StringBuilder();
      at++;
      while (at < text.length()) {
        char c = text.charAt(at++);
        if (c == '"') return out.toString();
        if (c != '\\') { out.append(c); continue; }
        char escaped = text.charAt(at++);
        switch (escaped) {
          case 'n' -> out.append('\n');
          case 't' -> out.append('\t');
          case 'r' -> out.append('\r');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'u' -> { out.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); at += 4; }
          default -> out.append(escaped);
        }
      }
      throw new IllegalArgumentException("unterminated string");
    }
  }
}
