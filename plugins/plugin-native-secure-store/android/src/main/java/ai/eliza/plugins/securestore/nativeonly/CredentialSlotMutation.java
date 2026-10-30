package ai.eliza.plugins.securestore.nativeonly;

import java.util.Objects;
import java.util.concurrent.Callable;

/** Guarded replacement of one existing credential value, with exact durable readback. */
public final class CredentialSlotMutation {
  private CredentialSlotMutation() {}

  public static <T> T replace(CredentialMutationConductor.Host host, Runnable guard,
      Callable<String> read, String replacement, Callable<T> write, Callable<Void> changed) throws Exception {
    return CredentialMutationConductor.mutate(host, guard, new CredentialMutationConductor.Mutation<T>() {
      String before;
      public boolean requiresShutdown() throws Exception {
        before = read.call();
        return !Objects.equals(before, replacement);
      }
      public T commit() throws Exception {
        if (!Objects.equals(before, read.call())) throw new IllegalStateException("Credential changed");
        if (!Objects.equals(before, replacement)) changed.call();
        T result = write.call();
        if (!Objects.equals(replacement, read.call())) throw new IllegalStateException("Credential commit unconfirmed");
        return result;
      }
    });
  }
}
