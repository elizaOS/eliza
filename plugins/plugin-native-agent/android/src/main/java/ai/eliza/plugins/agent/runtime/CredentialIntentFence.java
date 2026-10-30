package ai.eliza.plugins.agent.runtime;

/** Compatibility name for the shared secure-store credential intent fence. */
public final class CredentialIntentFence {
  private final ai.eliza.plugins.securestore.nativeonly.CredentialIntentFence delegate;
  public CredentialIntentFence() { delegate = new ai.eliza.plugins.securestore.nativeonly.CredentialIntentFence(); }
  public CredentialIntentFence(Object lock) { delegate = new ai.eliza.plugins.securestore.nativeonly.CredentialIntentFence(lock); }
  public long reserve() { return delegate.reserve(); }
  public long current() { return delegate.current(); }
  public void require(long intent) { delegate.require(intent); }
  public boolean isCurrent(long intent) { return delegate.isCurrent(intent); }
}
