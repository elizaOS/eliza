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
 static final class Disk implements CredentialIntentFence.Ledger {
  String value; boolean failWrites, failReads; int writes;
  public String read() { if (failReads) throw new IllegalStateException("controlled read failure"); return value; }
  public void write(String generation) { if (failWrites) throw new IllegalStateException("controlled write failure"); value = generation; writes++; }
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
  broken.failWrites = false;
  failing.reserve();
  check(failing.generation() != null && !before.equals(failing.generation()) && failing.generation().equals(broken.value), "the next reservation records again");
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
