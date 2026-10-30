package ai.eliza.plugins.agent.runtime;

import ai.eliza.plugins.securestore.nativeonly.CredentialMutationConductor;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Objects;
import org.json.JSONArray;
import org.json.JSONObject;

/** Shared provider/Cloud mutation policy over the product's existing protected slots. */
public final class ResidentCredentialStore {
  public interface Slots {
    String read(String name) throws Exception;
    void write(String name, String value) throws Exception;
    void remove(String name) throws Exception;
  }

  public interface Authority {
    Object credentialLock();
    void assertCurrent();
    <T> T mutate(Runnable additionalGuard, CredentialMutationConductor.Mutation<T> mutation) throws Exception;
    default <T> T mutate(CredentialMutationConductor.Mutation<T> mutation) throws Exception {
      return mutate(() -> {}, mutation);
    }
    long epoch();
    long intent();
    <T> T withEpoch(long expected, java.util.concurrent.Callable<T> action) throws Exception;
    void changed();
    boolean admissionReadable();
  }

  /** Existing host effects, such as legacy recovery journals and account-bound background work. */
  public interface Compatibility {
    void beforeMutation() throws Exception;
    void cloudChanged() throws Exception;
    void clearPendingReturn() throws Exception;
  }

  private final Slots slots;
  private final Authority authority;
  private final Compatibility compatibility;
  private final String providerSlot, cloudSlot, otherCloudSlot;

  public ResidentCredentialStore(Slots slots, Authority authority, Compatibility compatibility,
      String providerSlot, String cloudSlot, String otherCloudSlot) {
    this.slots = Objects.requireNonNull(slots);
    this.authority = Objects.requireNonNull(authority);
    this.compatibility = Objects.requireNonNull(compatibility);
    this.providerSlot = Objects.requireNonNull(providerSlot);
    this.cloudSlot = Objects.requireNonNull(cloudSlot);
    this.otherCloudSlot = Objects.requireNonNull(otherCloudSlot);
  }

  public boolean mutateSlot(String name, String expected, String value, boolean compare) throws Exception {
    if (!cloudSlot.equals(name) && !otherCloudSlot.equals(name) && !providerSlot.equals(name)) {
      synchronized (authority.credentialLock()) {
        authority.assertCurrent();
        if (compare && !Objects.equals(slots.read(name), expected)) return false;
        if (value == null) slots.remove(name); else slots.write(name, value);
        return true;
      }
    }
    return mutateCritical(name, expected, value, compare, normalized -> {
      if (normalized == null) slots.remove(name); else slots.write(name, normalized);
      return true;
    }, false, true);
  }

  private interface Commit<T> { T write(String value) throws Exception; }

  private <T> T mutateCritical(String name, String expected, String value, boolean compare,
      Commit<T> commit, T conflictValue, T unchangedValue) throws Exception {
    return authority.mutate(new CredentialMutationConductor.Mutation<T>() {
      String before, provider;
      boolean conflict;
      public boolean requiresShutdown() throws Exception {
        before = slots.read(name);
        provider = slots.read(providerSlot);
        conflict = compare && !Objects.equals(before, expected);
        if (conflict) return false;
        compatibility.beforeMutation();
        if (providerSlot.equals(name)) return before != null || value != null;
        if (Objects.equals(before, value) || provider == null) return false;
        return name.equals(selectedCloudSlot(new JSONObject(provider)))
            && !NativeProviderAdmission.sameCloudCredential(before, value);
      }
      public T commit() throws Exception {
        if (conflict) return conflictValue;
        if (!providerSlot.equals(name) && Objects.equals(before, value)) return unchangedValue;
        if (!Objects.equals(before, slots.read(name)) || !Objects.equals(provider, slots.read(providerSlot)))
          throw new IllegalStateException("Credential changed");
        if (cloudSlot.equals(name) && !NativeProviderAdmission.sameCloudCredential(before, value))
          compatibility.cloudChanged();
        String committed = providerSlot.equals(name) && value != null
            ? NativeProviderAdmission.withoutAdmission(value) : value;
        boolean changed = providerSlot.equals(name) ? !Objects.equals(before, committed)
            : !NativeProviderAdmission.sameCloudCredential(before, committed);
        if (changed) authority.changed();
        invalidateProviderAdmission(name, value);
        if (cloudSlot.equals(name) && changed) compatibility.clearPendingReturn();
        T result = commit.write(committed);
        if (!Objects.equals(committed, slots.read(name))) throw new IllegalStateException("Credential commit unconfirmed");
        return result;
      }
    });
  }

  private void invalidateProviderAdmission(String name, String replacement) throws Exception {
    if (!cloudSlot.equals(name) && !otherCloudSlot.equals(name)) return;
    String saved = slots.read(providerSlot);
    if (saved == null) return;
    JSONObject provider = new JSONObject(saved);
    if (!name.equals(selectedCloudSlot(provider))) return;
    String previous = slots.read(name);
    if (replacement != null && NativeProviderAdmission.currentGeneration(saved, previous) != null
        && NativeProviderAdmission.sameCloudCredential(previous, replacement)) return;
    slots.write(providerSlot, NativeProviderAdmission.withoutAdmission(saved));
  }

  private String selectedCloudSlot(JSONObject provider) {
    String environment = provider.optString("environment", "production");
    return "production".equals(environment) ? cloudSlot : "staging".equals(environment) ? otherCloudSlot : null;
  }

  public String compareExchangeAdmission(String expected, String selection, String credentialSlot,
      String expectedCredential, JSONObject identity) throws Exception {
    return authority.mutate(new CredentialMutationConductor.Mutation<String>() {
      String admitted;
      boolean conflict;
      public boolean requiresShutdown() throws Exception {
        conflict = credentialSlot != null && !Objects.equals(slots.read(credentialSlot), expectedCredential)
            || !Objects.equals(slots.read(providerSlot), expected);
        if (conflict) return false;
        compatibility.beforeMutation();
        boolean cloud = "elizacloud".equals(new JSONObject(selection).optString("provider"));
        if (cloud ? !cloudSlot.equals(credentialSlot)
            : credentialSlot != null || expectedCredential != null || identity != null)
          throw new IllegalArgumentException();
        admitted = NativeProviderAdmission.admit(expected, selection, expectedCredential, identity);
        String old = expected == null ? null : NativeProviderAdmission.currentGeneration(expected, expectedCredential);
        return old == null || !old.equals(NativeProviderAdmission.currentGeneration(admitted, expectedCredential));
      }
      public String commit() throws Exception {
        if (conflict) return null;
        if (credentialSlot != null && !Objects.equals(slots.read(credentialSlot), expectedCredential)
            || !Objects.equals(slots.read(providerSlot), expected))
          throw new IllegalStateException("Provider changed");
        String generation = NativeProviderAdmission.currentGeneration(admitted, expectedCredential);
        if (generation == null) throw new IllegalStateException("Provider credential expired");
        String previous = expected == null ? null : NativeProviderAdmission.currentGeneration(expected, expectedCredential);
        if (previous == null || !previous.equals(generation)) authority.changed();
        slots.write(providerSlot, admitted);
        if (!admitted.equals(slots.read(providerSlot))) throw new IllegalStateException("Provider commit unconfirmed");
        return admitted;
      }
    });
  }

  public void rollbackAdmission(String admitted, String previous) throws Exception {
    authority.mutate(new CredentialMutationConductor.Mutation<Void>() {
      String current;
      boolean owned;
      public boolean requiresShutdown() throws Exception {
        current = slots.read(providerSlot);
        if (current == null) return false;
        JSONObject held = new JSONObject(current);
        owned = Objects.equals(current, admitted)
            || !held.has("admissionGeneration") && !held.has("admissionFingerprint")
            && NativeProviderAdmission.withoutAdmission(admitted).equals(held.toString());
        return owned;
      }
      public Void commit() throws Exception {
        if (!owned) return null;
        if (!Objects.equals(current, slots.read(providerSlot))) throw new IllegalStateException("Provider changed");
        authority.changed();
        if (previous == null) slots.remove(providerSlot);
        else slots.write(providerSlot, NativeProviderAdmission.withoutAdmission(previous));
        String expected = previous == null ? null : NativeProviderAdmission.withoutAdmission(previous);
        if (!Objects.equals(expected, slots.read(providerSlot))) throw new IllegalStateException("Provider rollback unconfirmed");
        return null;
      }
    });
  }

  public String bindingGuard(String expected) throws Exception {
    long epoch = authority.epoch();
    return authority.withEpoch(epoch, () -> {
      authority.assertCurrent();
      String provider = slots.read(providerSlot);
      if (provider == null || expected != null && !expected.equals(provider)) throw new SecurityException("Provider changed");
      String value = new JSONArray().put(provider).put(slots.read(cloudSlot)).put(epoch).put(authority.intent()).toString();
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder hash = new StringBuilder();
      for (byte b : digest) hash.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      return hash.toString();
    });
  }

  public boolean removeIfCurrent(String guard, java.util.function.LongSupplier reserveIntent,
      java.util.function.LongConsumer requireIntent) throws Exception {
    if (guard == null || !guard.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid binding guard");
    final long[] intent = {-1};
    try {
      return authority.mutate(() -> {
        if (intent[0] >= 0) requireIntent.accept(intent[0]);
      }, new CredentialMutationConductor.Mutation<Boolean>() {
        String provider, cloud;
        long epoch;
        public boolean requiresShutdown() throws Exception {
          try { if (!guard.equals(bindingGuard(null))) throw new ProviderChanged(); }
          catch (SecurityException changed) { throw new ProviderChanged(); }
          provider = slots.read(providerSlot);
          cloud = slots.read(cloudSlot);
          epoch = authority.epoch();
          intent[0] = reserveIntent.getAsLong();
          compatibility.beforeMutation();
          return true;
        }
        public Boolean commit() throws Exception {
          requireIntent.accept(intent[0]);
          if (epoch != authority.epoch() || !Objects.equals(provider, slots.read(providerSlot))
              || !Objects.equals(cloud, slots.read(cloudSlot))) throw new ProviderChanged();
          authority.changed();
          slots.remove(providerSlot);
          if (slots.read(providerSlot) != null) throw new IllegalStateException("Provider removal unconfirmed");
          return true;
        }
      });
    } catch (ProviderChanged changed) { return false; }
    catch (Exception failure) {
      if (intent[0] >= 0 && authority.intent() != intent[0]) return false;
      throw failure;
    }
  }

  public JSONObject admissionSnapshot() throws Exception {
    synchronized (authority.credentialLock()) {
      String saved = slots.read(providerSlot);
      if (saved == null || !authority.admissionReadable()) throw new SecurityException("Native provider binding unavailable");
      JSONObject selected = new JSONObject(saved);
      String kind = selected.optString("provider", "cerebras");
      String cloud = "elizacloud".equals(kind) ? slots.read(cloudSlot) : null;
      String generation = NativeProviderAdmission.currentGeneration(saved, cloud);
      if (generation == null) throw new SecurityException("Native provider binding unavailable");
      String account = "elizacloud".equals(kind) ? NativeProviderAdmission.cloudAccountRef(selected) : "native-local";
      return new JSONObject().put("provider", kind).put("environment", "production")
          .put("accountRef", account).put("sessionGeneration", generation);
    }
  }

  public String admissionGeneration() throws Exception {
    synchronized (authority.credentialLock()) {
      String saved = slots.read(providerSlot);
      if (saved == null || !authority.admissionReadable()) return null;
      JSONObject selected = new JSONObject(saved);
      return NativeProviderAdmission.currentGeneration(saved,
          "elizacloud".equals(selected.optString("provider")) ? slots.read(cloudSlot) : null);
    }
  }

  private static final class ProviderChanged extends Exception {}
}
