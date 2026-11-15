package ai.eliza.plugins.securestore.nativeonly;

import java.util.function.LongSupplier;

/** Main-thread, ephemeral device-authentication grant. Never persists authority. */
public final class CredentialAccessSession {
  private final LongSupplier clock;
  private final long duration;
  private long generation, pending, grantedAt = -1;
  private boolean closed;

  public CredentialAccessSession(LongSupplier clock, long durationMillis) {
    if (clock == null || durationMillis <= 0) throw new IllegalArgumentException("Invalid authentication policy");
    this.clock = clock;
    this.duration = durationMillis;
  }

  /** Zero means a challenge is already pending, or this session is closed. */
  public long begin() {
    if (closed || pending != 0) return 0;
    grantedAt = -1;
    if (generation == Long.MAX_VALUE) { close(); return 0; }
    pending = ++generation;
    return pending;
  }

  /** Only the outstanding challenge can grant access; duplicate/old results do nothing. */
  public boolean complete(long ticket, boolean accepted) {
    if (closed || ticket == 0 || ticket != pending) return false;
    pending = 0;
    grantedAt = -1;
    if (!accepted) return false;
    long now = clock.getAsLong();
    if (now < 0) return false;
    grantedAt = now;
    return true;
  }

  public boolean pending() { return !closed && pending != 0; }

  /** Absolute elapsed time, independent of timer delivery and user interaction. */
  public long remainingMillis() {
    if (closed || grantedAt < 0) return 0;
    long now = clock.getAsLong();
    if (now < grantedAt || now - grantedAt >= duration) { grantedAt = -1; return 0; }
    return duration - (now - grantedAt);
  }

  public boolean authenticated() { return remainingMillis() > 0; }

  /** Bind queued work to this grant; a later unlock cannot revive it. */
  public long currentTicket() { return authenticated() ? generation : 0; }
  public boolean authenticated(long ticket) { return ticket != 0 && ticket == generation && authenticated(); }

  /** Cancelling an old owner must not revoke a newer owner's challenge or grant. */
  public void lock(long ticket) { if (ticket != 0 && ticket == generation) lock(); }

  /** Android stops the host while its device challenge is in front. Keep only that challenge. */
  public void stop() { grantedAt = -1; }

  public void lock() { pending = 0; grantedAt = -1; }

  public void close() { lock(); closed = true; }
}
