// spec/os/appUpdate/health.md, "Evidence names the installation it was asked about and is sent only before the deadline of an open service"
package ai.eliza.plugins.agent.contract;

import ai.eliza.plugins.agent.health.HealthWork.Verdict;
import ai.eliza.plugins.agent.health.NativeHealthEvidence;
import ai.eliza.plugins.agent.health.NativeHealthEvidence.Subject;
import java.io.IOException;
import org.json.JSONObject;

public final class NativeHealthContract {
  private NativeHealthContract() {}

  private static final String NONCE = "a".repeat(64);
  private static final String DIGEST = "b".repeat(64);

  private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }

  private static void refused(String body, Subject subject, long now, String message) {
    try { NativeHealthEvidence.parse(body, NONCE, subject, 90, now, 120); throw new AssertionError(message); } catch (IOException expected) {}
  }

  public static void run() throws Exception {
    Subject subject = new Subject("plan-1", 3, 7, 41, DIGEST);
    String passed = new NativeHealthEvidence(subject, Verdict.PASSED).encode(NONCE, 100);
    NativeHealthEvidence read = NativeHealthEvidence.parse(passed, NONCE, subject, 90, 110, 120);
    check(read.verdict == Verdict.PASSED && read.subject == subject, "Passed evidence lost");
    String failed = new NativeHealthEvidence(subject, Verdict.FAILED).encode(NONCE, 100);
    check(NativeHealthEvidence.parse(failed, NONCE, subject, 90, 110, 120).verdict == Verdict.FAILED, "Failed evidence lost");
    check(!new JSONObject(passed).has("gatewayResponsive"), "Gateway field still sent");

    Object[][] changes = {
      {"nonce", "c".repeat(64)}, {"versionCode", 42}, {"planId", "plan-2"}, {"generation", 4}, {"revision", 6},
      {"installed", "c".repeat(64)}, {"verdict", "unknown"}, {"schemaVersion", 5}, {"schemaVersion", "6"},
      {"observedElapsed", 89}, {"observedElapsed", 111}, {"generation", -1}, {"gatewayResponsive", true}, {"distribution", "standalone"}
    };
    for (Object[] change : changes) refused(new JSONObject(passed).put((String) change[0], change[1]).toString(), subject, 110, "Accepted changed " + change[0]);
    JSONObject missing = new JSONObject(passed);
    missing.remove("revision");
    refused(missing.toString(), subject, 110, "Accepted evidence without its revision");
    refused(passed, new Subject("plan-1", 3, 8, 41, DIGEST), 110, "Accepted evidence for another journal revision");
    refused(passed, new Subject("plan-1", 3, 7, 41, "c".repeat(64)), 110, "Accepted evidence for another installed artifact");
    for (long now : new long[] {89, 120, 121}) refused(passed, subject, now, "Accepted evidence at " + now);
    refused("x".repeat(NativeHealthEvidence.MAX_BODY + 1), subject, 110, "Accepted an oversized body");
    refused("not json", subject, 110, "Accepted a malformed body");
    refused(null, subject, 110, "Accepted no body");

    for (Object[] bad : new Object[][] {{"", 0L, 0L, 1L, DIGEST}, {"plan/1", 0L, 0L, 1L, DIGEST}, {"p", -1L, 0L, 1L, DIGEST}, {"p", 0L, 0L, 0L, DIGEST}, {"p", 0L, 0L, 1L, "B".repeat(64)}}) {
      try { new Subject((String) bad[0], (Long) bad[1], (Long) bad[2], (Long) bad[3], (String) bad[4]); throw new AssertionError("Invalid subject accepted"); } catch (IllegalArgumentException expected) {}
    }
  }
}
