package ai.eliza.plugins.agent.runtime;

/**
 * Last-intent-wins fence over credential and provider configuration. Every explicit user action
 * that writes or removes a credential (a Cloud sign-in slot, a provider selection) reserves a new
 * intent before its background work starts, and every store write it makes requires that intent to
 * still be the newest. An older action that finishes late therefore cannot overwrite what a newer
 * one saved, and a sign-out cannot be undone by a slow sign-in. The product holds one fence per
 * process and shares it between its connection and local-agent bridges.
 */
public final class CredentialIntentFence {
  private final Object lock;
  private long epoch;

  /** A fence guarded by its own lock. */
  public CredentialIntentFence() {
    this(new Object());
  }

  /** A fence guarded by the caller's lifecycle lock, so it composes with other lifecycle state. */
  public CredentialIntentFence(Object lock) {
    this.lock = lock;
  }

  /** Supersedes every earlier intent and returns the new one. */
  public long reserve() {
    synchronized (lock) {
      return ++epoch;
    }
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
