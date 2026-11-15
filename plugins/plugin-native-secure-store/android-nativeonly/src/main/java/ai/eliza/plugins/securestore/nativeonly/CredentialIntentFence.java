package ai.eliza.plugins.securestore.nativeonly;

/**
 * Last-intent-wins fence over credential and provider configuration. Every explicit user action
 * that writes or removes a credential (a Cloud sign-in slot, a provider selection) reserves a new
 * intent before its background work starts, and every store write it makes requires that intent to
 * still be the newest. An older action that finishes late therefore cannot overwrite what a newer
 * one saved, and a sign-out cannot be undone by a slow sign-in. The product holds one fence per
 * process and shares it between its connection and local-agent bridges.
 *
 * <p>Intents are process-local. A host that must recognise, in a new process, work that an earlier
 * process began (a browser sign-in whose return restarts the app) attaches a {@link Ledger}: every
 * reservation then records a fresh durable generation, and {@link #adopt} admits the earlier work
 * only while its generation is still the recorded one, that is, while no credential action was
 * reserved after it in any process. Without a ledger nothing changes and nothing is adopted.
 *
 * <p>A reservation whose generation cannot be recorded must not leave the previous one on disk for a
 * later process to trust: the write is tried twice, then the stored value is cleared, and while even
 * that fails every later use of the fence tries again. Only a ledger that accepts neither a write nor
 * a clear until the process ends can leave a stale generation behind; a host closes that case by
 * removing the earlier work's own record (the pending sign-in) in the action that reserved.
 */
public final class CredentialIntentFence {
  /**
   * Durable storage of the newest generation (one short value, for example a private no-backup file
   * or preferences entry written synchronously). It need not be secret.
   */
  public interface Ledger {
    /** The recorded generation, or null when none was recorded. */
    String read() throws Exception;

    /**
     * Records {@code generation} durably before returning, as an atomic replacement: a reader sees the
     * old value or the new one, never a mixture.
     */
    void write(String generation) throws Exception;

    /**
     * Removes the recorded generation durably before returning (delete the file or entry). Called
     * when a new generation could not be written, so that a later process finds nothing to adopt.
     */
    void clear() throws Exception;
  }

  private final Object lock;
  private long epoch;
  private Ledger ledger;
  /** The recorded generation of the newest intent; null while unknown or unrecorded. */
  private String generation;
  /** The ledger may still hold a generation older than the newest intent: neither a write nor a clear succeeded. */
  private boolean stale;

  /** A fence guarded by its own lock. */
  public CredentialIntentFence() {
    this(new Object());
  }

  /** A fence guarded by the caller's lifecycle lock, so it composes with other lifecycle state. */
  public CredentialIntentFence(Object lock) {
    this.lock = lock;
  }

  /**
   * Attaches durable generation storage, once, before the host handles anything an earlier process
   * began. Reservations made in this process before the attachment are recorded now, so they are
   * never mistaken for "nothing happened". Later calls are ignored.
   */
  public void attach(Ledger ledger) {
    if (ledger == null) throw new IllegalArgumentException("Generation ledger required");
    synchronized (lock) {
      if (this.ledger != null) return;
      this.ledger = ledger;
      if (epoch == 0) {
        try {
          generation = valid(ledger.read());
        } catch (Exception unreadable) {
          generation = null;
        }
      }
      if (generation == null) record();
    }
  }

  /** Supersedes every earlier intent and returns the new one. */
  public long reserve() {
    synchronized (lock) {
      ++epoch;
      if (ledger != null) record();
      return epoch;
    }
  }

  /**
   * The durable generation of the newest intent, or null when no ledger is attached or the last
   * record failed. A value read after a reservation and stored with that reservation's work
   * identifies it to {@link #adopt} in a later process.
   */
  public String generation() {
    synchronized (lock) {
      if (stale) record();
      return generation;
    }
  }

  /**
   * The newest intent when {@code expected} is still the recorded generation: no intent was reserved
   * since that generation was recorded, in this process or an earlier one. Reserves nothing. -1 when
   * a newer intent exists, when nothing is recorded or when no ledger is attached.
   */
  public long adopt(String expected) {
    synchronized (lock) {
      if (stale) record();
      return generation != null && generation.equals(expected) ? epoch : -1;
    }
  }

  /**
   * Records a fresh generation for the newest intent. When the write fails twice the stored value is
   * cleared instead, so no later process adopts what this intent superseded; this process then has no
   * generation, adopts nothing and hands out none, and the next reservation records again. When the
   * clear fails as well the ledger is stale, and every later reservation, {@link #generation} and
   * {@link #adopt} tries to record again first.
   */
  private void record() {
    String next = java.util.UUID.randomUUID().toString();
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        ledger.write(next);
        generation = next;
        stale = false;
        return;
      } catch (Exception unrecorded) {
        // Tried once more, then cleared.
      }
    }
    generation = null;
    try {
      ledger.clear();
      stale = false;
    } catch (Exception uncleared) {
      stale = true;
    }
  }

  private static String valid(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{1,128}") ? value : null;
  }

  /** The newest intent (for a continuation that must observe no later reservation). */
  public long current() {
    synchronized (lock) {
      return epoch;
    }
  }

  /** IllegalStateException when a newer intent has been reserved since intent. */
  public void require(long intent) {
    synchronized (lock) {
      if (intent != epoch) throw new IllegalStateException("Credential intent changed");
    }
  }

  /** Whether intent is still the newest. */
  public boolean isCurrent(long intent) {
    synchronized (lock) {
      return intent == epoch;
    }
  }
}
