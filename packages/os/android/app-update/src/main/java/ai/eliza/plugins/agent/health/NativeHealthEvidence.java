// spec/os/appUpdate/health.md, "Evidence names the installation it was asked about and is sent only before the deadline of an open service"
package ai.eliza.plugins.agent.health;

import ai.eliza.plugins.agent.health.HealthWork.Verdict;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

public final class NativeHealthEvidence {
  public static final int SCHEMA = 6;
  public static final int MAX_BODY = 4096;
  public static final String NONCE = "[a-f0-9]{64}";
  public static final Set<String> REQUEST_KEYS =
    Set.of("nonce", "versionCode", "deadlineElapsed", "planId", "generation", "revision", "installed");
  private static final Set<String> BODY_KEYS =
    Set.of("schemaVersion", "nonce", "versionCode", "observedElapsed", "planId", "generation", "revision", "installed", "verdict");

  public static final class Subject {
    public final String planId, installed;
    public final long generation, revision, versionCode;
    public Subject(String planId, long generation, long revision, long versionCode, String installed) {
      if (planId == null || !planId.matches("[A-Za-z0-9._-]{1,96}") || generation < 0 || revision < 0
          || versionCode < 1 || versionCode > 2100000000L || installed == null || !installed.matches("[a-f0-9]{64}"))
        throw new IllegalArgumentException("Invalid health subject");
      this.planId = planId; this.generation = generation; this.revision = revision; this.versionCode = versionCode; this.installed = installed;
    }
  }

  public final Subject subject;
  public final Verdict verdict;

  public NativeHealthEvidence(Subject subject, Verdict verdict) {
    if (subject == null || verdict == null) throw new IllegalArgumentException("Health evidence needs its subject and verdict");
    this.subject = subject; this.verdict = verdict;
  }

  public String encode(String nonce, long observedElapsed) {
    try {
      return new JSONObject().put("schemaVersion", SCHEMA).put("nonce", nonce).put("versionCode", subject.versionCode)
        .put("observedElapsed", observedElapsed).put("planId", subject.planId).put("generation", subject.generation)
        .put("revision", subject.revision).put("installed", subject.installed)
        .put("verdict", verdict == Verdict.PASSED ? "passed" : "failed").toString();
    } catch (JSONException unencodable) {
      throw new IllegalStateException(unencodable);
    }
  }

  public static NativeHealthEvidence parse(String body, String nonce, Subject subject, long started, long now, long deadline) throws IOException {
    if (body == null || body.length() > MAX_BODY) throw new IOException("Health response budget");
    try {
      JSONObject value = new JSONObject(body);
      Set<String> keys = new HashSet<>();
      value.keys().forEachRemaining(keys::add);
      if (!keys.equals(BODY_KEYS)) throw new IOException("Health response fields");
      for (String name : Arrays.asList("schemaVersion", "versionCode", "observedElapsed", "generation", "revision")) {
        Object number = value.get(name);
        if (!(number instanceof Integer || number instanceof Long) || ((Number) number).longValue() < 0) throw new IOException("Health numeric type");
      }
      if (value.getLong("schemaVersion") != SCHEMA || !nonce.equals(value.get("nonce")) || value.getLong("versionCode") != subject.versionCode
          || !subject.planId.equals(value.get("planId")) || value.getLong("generation") != subject.generation
          || value.getLong("revision") != subject.revision || !subject.installed.equals(value.get("installed")))
        throw new IOException("Health subject mismatch");
      long observed = value.getLong("observedElapsed");
      if (started < 0 || deadline <= started || now < started || now >= deadline || observed < started || observed > now)
        throw new IOException("Stale health observation");
      Object verdict = value.get("verdict");
      if (!"passed".equals(verdict) && !"failed".equals(verdict)) throw new IOException("Invalid health verdict");
      return new NativeHealthEvidence(subject, "passed".equals(verdict) ? Verdict.PASSED : Verdict.FAILED);
    } catch (JSONException malformed) {
      throw new IOException("Health response malformed", malformed);
    }
  }
}
