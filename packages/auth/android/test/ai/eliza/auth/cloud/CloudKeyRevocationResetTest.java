package ai.eliza.auth.cloud;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The bounded reset revocation step on a plain JVM: synthetic slots and a synthetic transport. No
 * network, Android or real credential. Moved here from Alpha's ResetCloudRevocation fixture.
 */
public final class CloudKeyRevocationResetTest {
 private static int checks;
 private static void check(boolean ok, String what) { checks++; if (!ok) throw new AssertionError(what); }
 private static String saved(String token) { return new org.json.JSONObject().put("token", token).put("credentialId", "synthetic").toString(); }

 public static void main(String[] args) throws Exception {
  List<String> slotsRead = new ArrayList<>(), revoked = new ArrayList<>();
  AtomicInteger calls = new AtomicInteger();
  CloudKeyRevocation.Transport recording = (config, environment, token) -> { calls.incrementAndGet(); revoked.add(environment.name + "=" + token); return true; };

  // Production only: one slot read, one revocation of its token.
  int confirmed = CloudKeyRevocation.revokeSaved(TestRegistration.PRODUCT, slot -> { slotsRead.add(slot); return saved("eliza_mobile_production"); }, 1000, recording);
  check(confirmed == 1 && slotsRead.equals(List.of("cloud:production")) && revoked.equals(List.of("production=eliza_mobile_production")), "production key revoked");

  // A development registration revokes each environment in order.
  slotsRead.clear(); revoked.clear();
  confirmed = CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> { slotsRead.add(slot); return saved("eliza_mobile_" + slot.substring(6)); }, 1000, recording);
  check(confirmed == 2 && slotsRead.equals(List.of("cloud:production", "cloud:staging")), "every registered environment");

  // Missing, unreadable, damaged and malformed slots skip only that environment.
  calls.set(0);
  check(CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> null, 1000, recording) == 0 && calls.get() == 0, "nothing saved");
  check(CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> { throw new Exception("store locked"); }, 1000, recording) == 0 && calls.get() == 0, "unreadable store");
  check(CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> "not-a-record", 1000, recording) == 0 && calls.get() == 0, "damaged record");
  check(CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> slot.endsWith("production") ? saved("bad token") : saved("eliza_mobile_staging"), 1000, recording) == 1 && calls.get() == 1, "malformed bearer skipped");
  // An unconfirmed server answer is not counted but does not stop the next environment.
  calls.set(0);
  check(CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> saved("eliza_mobile_key"), 1000, (c, e, t) -> { calls.incrementAndGet(); return false; }) == 0 && calls.get() == 2, "unconfirmed revocation");

  // No budget, null ports: nothing runs.
  calls.set(0);
  check(CloudKeyRevocation.revokeSaved(TestRegistration.PRODUCT, slot -> saved("eliza_mobile_key"), 0, recording) == 0 && calls.get() == 0, "zero budget");
  check(CloudKeyRevocation.revokeSaved(null, slot -> saved("eliza_mobile_key"), 1000, recording) == 0, "no registration");

  // A blocked transport never holds the reset: the call returns near its budget and interrupts the worker.
  AtomicInteger interrupted = new AtomicInteger();
  long start = System.nanoTime();
  CloudKeyRevocation.revokeSaved(TestRegistration.DEVELOPMENT, slot -> saved("eliza_mobile_key"), 50, (c, e, t) -> {
   try { Thread.sleep(10_000); } catch (InterruptedException expected) { interrupted.incrementAndGet(); }
   return true;
  });
  long elapsedMs = (System.nanoTime() - start) / 1_000_000;
  check(elapsedMs < 2000, "bounded by its budget");
  for (int i = 0; i < 100 && interrupted.get() == 0; i++) Thread.sleep(10);
  check(interrupted.get() == 1, "worker interrupted at the deadline, staging not attempted");

  // A budget above the cap is capped (the call cannot wait 60 s).
  start = System.nanoTime();
  CloudKeyRevocation.revokeSaved(TestRegistration.PRODUCT, slot -> saved("eliza_mobile_key"), 60_000, (c, e, t) -> { try { Thread.sleep(CloudKeyRevocation.RESET_BUDGET_CAP_MS + 5_000); } catch (InterruptedException expected) {} return true; });
  elapsedMs = (System.nanoTime() - start) / 1_000_000;
  check(elapsedMs >= CloudKeyRevocation.RESET_BUDGET_CAP_MS - 100 && elapsedMs < CloudKeyRevocation.RESET_BUDGET_CAP_MS + 2000, "capped at " + CloudKeyRevocation.RESET_BUDGET_CAP_MS + " ms, took " + elapsedMs);

  // An interrupted caller returns at once and keeps its interrupt.
  calls.set(0);
  Thread.currentThread().interrupt();
  CloudKeyRevocation.revokeSaved(TestRegistration.PRODUCT, slot -> saved("eliza_mobile_key"), 1000, recording);
  check(Thread.interrupted() && calls.get() == 0, "caller interrupt preserved");

  // The coordinator adapter reads the live registration and the host's context-bound slots.
  Object context = new Object();
  List<Object> contexts = new ArrayList<>();
  CloudSignInConfig[] live = { TestRegistration.PRODUCT };
  calls.set(0);
  CloudKeyRevocation.ResetStep<Object> step = CloudKeyRevocation.resetStep(() -> live[0], (c, slot) -> { contexts.add(c); return saved("eliza_mobile_key"); }, recording);
  step.run(context, 1000);
  check(calls.get() == 1 && contexts.equals(List.of(context)), "adapter passes the context");
  live[0] = TestRegistration.DEVELOPMENT;
  step.run(context, 1000);
  check(calls.get() == 3, "adapter reads the registration at reset time");
  try { CloudKeyRevocation.resetStep(null, (c, slot) -> null); check(false, "ports required"); } catch (IllegalArgumentException expected) { checks++; }

  System.out.println("PASS cloud reset revocation (" + checks + " checks)");
 }
}
