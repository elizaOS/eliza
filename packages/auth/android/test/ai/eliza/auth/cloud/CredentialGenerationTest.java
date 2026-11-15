package ai.eliza.auth.cloud;

import ai.eliza.plugins.securestore.nativeonly.CredentialIntentFence;

/**
 * The credential intent fence's durable generation, as a host uses it for a browser sign-in whose
 * return starts a new process: {@code generation()} after the attempt's reservation is stored with
 * the pending record, and {@code adopt(generation)} in the new process admits the return only while
 * no credential action was reserved since. Plain JVM; the ledger is a synthetic value.
 */
public final class CredentialGenerationTest {
 private static int checks;
 private static void check(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message); }
 /** One durable value shared by the "processes" of a scenario. */
 static class Disk implements CredentialIntentFence.Ledger {
  String value; boolean failWrites, failReads, failClears; int writes, writeAttempts, clears;
  public String read() { if (failReads) throw new IllegalStateException("controlled read failure"); return value; }
  public void write(String generation) { writeAttempts++; if (failWrites) throw new IllegalStateException("controlled write failure"); value = generation; writes++; }
  public void clear() { if (failClears) throw new IllegalStateException("controlled clear failure"); value = null; clears++; }
 }
 static CredentialIntentFence process(Disk disk) { CredentialIntentFence fence = new CredentialIntentFence(); fence.attach(disk); return fence; }

 public static void main(String[] args) {
  // Without a ledger nothing changes and nothing is adopted.
  CredentialIntentFence plain = new CredentialIntentFence();
  long first = plain.reserve();
  check(first == 1 && plain.isCurrent(first) && plain.generation() == null && plain.adopt("anything") == -1 && plain.adopt(null) == -1, "no ledger: process-local intents only");

  // A reservation records a fresh generation; the same process adopts it without reserving.
  Disk disk = new Disk();
  CredentialIntentFence one = process(disk);
  check(one.generation() != null && one.generation().equals(disk.value) && disk.writes == 1, "attachment records a first generation");
  long signIn = one.reserve();
  String written = one.generation();
  check(written != null && written.equals(disk.value) && written.matches("[A-Za-z0-9_-]{1,128}"), "a reservation records its generation durably");
  check(one.adopt(written) == signIn && one.current() == signIn, "adoption returns the newest intent and reserves nothing");

  // A new process with no reservation since: the earlier work is adopted, bound to the current intent.
  CredentialIntentFence two = process(disk);
  long adopted = two.adopt(written);
  check(adopted == 0 && two.current() == 0 && two.isCurrent(adopted) && disk.writes == 2, "a new process adopts work whose generation is still the recorded one");
  // Any reservation afterwards (sign-out, another sign-in, a provider change) ends it, here and in later processes.
  long signOut = two.reserve();
  check(signOut == 1 && !two.isCurrent(adopted) && two.adopt(written) == -1 && !written.equals(two.generation()), "a newer reservation supersedes the adopted work");
  CredentialIntentFence three = process(disk);
  check(three.adopt(written) == -1 && three.adopt(two.generation()) == 0, "a later process sees the newer generation only");

  // Reservations made before the ledger is attached are recorded at attachment.
  Disk early = new Disk();
  CredentialIntentFence writer = process(early);
  writer.reserve();
  String pending = writer.generation();
  CredentialIntentFence late = new CredentialIntentFence();
  late.reserve();
  late.attach(early);
  check(late.adopt(pending) == -1 && late.generation() != null && !pending.equals(late.generation()), "an unrecorded reservation is never mistaken for none");
  late.attach(new Disk());
  check(late.generation().equals(early.value), "a second attachment is ignored");

  // A failed record leaves the process with no generation: it hands out none and adopts nothing.
  Disk broken = new Disk();
  CredentialIntentFence failing = process(broken);
  failing.reserve();
  String before = failing.generation();
  broken.failWrites = true;
  long unrecorded = failing.reserve();
  check(failing.generation() == null && failing.adopt(before) == -1 && failing.isCurrent(unrecorded), "a failed record adopts nothing in this process");
  // Nor in a later one: the superseded generation is no longer on disk (the sign-out whose record
  // failed, then the host is killed while the browser is in front, then the page returns).
  check(broken.value == null && broken.clears == 1, "a record that cannot be written clears the stored generation after one more try");
  check(process(broken).adopt(before) == -1, "a later process adopts nothing a failed record superseded, while writes still fail");
  broken.failWrites = false;
  check(process(broken).adopt(before) == -1, "nor once writes work again");
  failing.reserve();
  check(failing.generation() != null && !before.equals(failing.generation()) && failing.generation().equals(broken.value), "the next reservation records again");
  // One failed write is tried again before anything is cleared.
  Disk flaky = new Disk() { int failures = 1; @Override public void write(String generation) { if (failures-- > 0) { writeAttempts++; throw new IllegalStateException("controlled single failure"); } super.write(generation); } };
  CredentialIntentFence retried = new CredentialIntentFence(); retried.attach(flaky);
  check(retried.generation() != null && retried.generation().equals(flaky.value) && flaky.clears == 0 && flaky.writeAttempts == 2, "a single failed write is retried, not cleared");
  // Neither a write nor a clear works: the ledger is stale, so every later use of the fence records
  // again before it answers, and the stale value is gone as soon as the storage accepts anything.
  Disk stuck = new Disk();
  CredentialIntentFence held = process(stuck);
  held.reserve();
  String superseded = held.generation();
  stuck.failWrites = true; stuck.failClears = true;
  held.reserve();
  check(superseded.equals(stuck.value) && held.generation() == null && held.adopt(superseded) == -1, "a stale ledger adopts nothing in the process that knows it is stale");
  stuck.failWrites = false;
  check(held.adopt(superseded) == -1 && stuck.value != null && !superseded.equals(stuck.value) && stuck.value.equals(held.generation()), "the next use of the fence replaces the stale generation without a new reservation");
  check(process(stuck).adopt(superseded) == -1, "and a later process no longer finds it");
  Disk clearable = new Disk();
  CredentialIntentFence cleared = process(clearable);
  cleared.reserve();
  String older = cleared.generation();
  clearable.failWrites = true; clearable.failClears = true;
  cleared.reserve();
  clearable.failClears = false;
  check(cleared.adopt(older) == -1 && clearable.value == null && process(clearable).adopt(older) == -1, "a clear that works later removes the stale generation as well");
  // An unreadable or malformed ledger starts a fresh generation.
  Disk unreadable = new Disk(); unreadable.value = "kept"; unreadable.failReads = true;
  check(process(unreadable).adopt("kept") == -1 && !"kept".equals(unreadable.value), "an unreadable ledger adopts nothing");
  Disk malformed = new Disk(); malformed.value = "not a generation";
  check(process(malformed).adopt("not a generation") == -1, "a malformed ledger value adopts nothing");
  try { new CredentialIntentFence().attach(null); check(false, "a ledger is required"); } catch (IllegalArgumentException expected) { checks++; }

  // The compatibility name used by the native agent delegates the same contract.
  Disk shared = new Disk();
  ai.eliza.plugins.agent.runtime.CredentialIntentFence compatible = new ai.eliza.plugins.agent.runtime.CredentialIntentFence();
  compatible.attach(shared);
  long intent = compatible.reserve();
  check(compatible.generation().equals(shared.value) && compatible.adopt(shared.value) == intent && compatible.adopt("other") == -1, "compatibility fence");
  System.out.println("PASS durable credential generation (" + checks + " checks)");
 }
}
