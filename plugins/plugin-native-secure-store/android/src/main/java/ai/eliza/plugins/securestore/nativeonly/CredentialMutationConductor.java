package ai.eliza.plugins.securestore.nativeonly;

/**
 * Serializes the existing resident's credential changes with its exact process retirement.
 * Hosts supply their existing lifecycle state and locks; this does not create another owner.
 */
public final class CredentialMutationConductor {
  private CredentialMutationConductor() {}

  public interface Mutation<T> {
    boolean requiresShutdown() throws Exception;
    T commit() throws Exception;
  }

  public interface Host {
    Object lifecycleLock();
    Object credentialLock();
    /** Retire calls/enrollment and return the existing lifecycle epoch. Called without the vault lock. */
    long beginRetirement() throws Exception;
    void requireCurrent(long epoch) throws Exception;
    /** Reserve the exact request before crossing Android's fallible dispatch boundary. */
    long reserveStop() throws Exception;
    void requestStop(long request) throws Exception;
    boolean stopped() throws Exception;
    boolean stopAcknowledged(long request) throws Exception;
    long elapsedRealtime();
    void sleep(long millis) throws InterruptedException;
    /**
     * End this mutation owner. Release its exact service lease only if no commit was attempted
     * or the commit completed. Abandonment still waits for the exact stop acknowledgement.
     * A failed/unconfirmed commit keeps starts fenced; stale
     * owners must never release a newer request. Called with lifecycle lock and no vault lock.
     */
    void finishMutation(long epoch, long stopRequest, boolean commitAttempted, boolean commitConfirmed);
    /** Called with lifecycle then credential lock, including changes that need no process stop. */
    <T> T commit(Mutation<T> mutation) throws Exception;
  }

  public static <T> T mutate(Host host, Runnable assertOwner, Mutation<T> mutation) throws Exception {
    final long epoch;
    synchronized (host.lifecycleLock()) {
      assertOwner.run();
      synchronized (host.credentialLock()) {
        if (!mutation.requiresShutdown()) return host.commit(mutation);
      }
      epoch = host.beginRetirement();
    }
    long request = -1;
    boolean commitAttempted = false, commitConfirmed = false;
    try {
      synchronized (host.lifecycleLock()) {
        assertOwner.run();
        host.requireCurrent(epoch);
        request = host.reserveStop();
        host.requestStop(request);
      }
      long deadline = host.elapsedRealtime() + 15_000;
      while (true) {
        synchronized (host.lifecycleLock()) {
          assertOwner.run();
          host.requireCurrent(epoch);
        }
        boolean stopped = host.stopped();
        synchronized (host.lifecycleLock()) {
          assertOwner.run();
          host.requireCurrent(epoch);
          if (stopped && host.stopAcknowledged(request)) {
            synchronized (host.credentialLock()) {
              commitAttempted = true;
              T result = host.commit(mutation);
              commitConfirmed = true;
              return result;
            }
          }
        }
        if (host.elapsedRealtime() >= deadline) throw new IllegalStateException("Native shutdown unconfirmed");
        host.sleep(50);
      }
    } finally {
      synchronized (host.lifecycleLock()) {
        host.finishMutation(epoch, request, commitAttempted, commitConfirmed);
      }
    }
  }
}
