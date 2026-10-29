package ai.eliza.plugins.agent.connection;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Which encrypted-storage slots a renderer may name. Native-owned namespaces (provider admission,
 * journals, sign-in state) are refused outright so renderer storage can never bypass a native
 * state machine; compare-and-exchange is admitted only for the declared draft and pending-action
 * slots, never for credentials; and credential slots are named so a write or removal can be fenced
 * by a credential intent ({@link ai.eliza.plugins.agent.runtime.CredentialIntentFence}). The
 * product injects its namespaces; the rules are shared and tested on the host JVM.
 */
public final class SecureSlotPolicy {
  /** Longest slot name. */
  public static final int NAME_LIMIT = 1024;

  private final List<String> nativeNamespaces;
  private final List<Pattern> compareExchange;
  private final List<String> credentialSlots;

  /**
   * @param nativeNamespaces names refused exactly and as {@code <namespace>:} prefixes
   * @param compareExchange full-match patterns of slots that admit compare-and-exchange
   * @param credentialSlots exact slots whose writes and removals take a credential intent
   */
  public SecureSlotPolicy(List<String> nativeNamespaces, List<String> compareExchange, List<String> credentialSlots) {
    this.nativeNamespaces = Collections.unmodifiableList(new ArrayList<>(nativeNamespaces));
    List<Pattern> patterns = new ArrayList<>();
    for (String pattern : compareExchange) patterns.add(Pattern.compile(pattern));
    this.compareExchange = Collections.unmodifiableList(patterns);
    this.credentialSlots = Collections.unmodifiableList(new ArrayList<>(credentialSlots));
  }

  /** The slot when a renderer may name it; SecurityException otherwise. */
  public String requireRendererSlot(String slot) {
    if (slot == null || slot.isEmpty() || slot.length() > NAME_LIMIT) throw new SecurityException("Invalid credential slot");
    for (String namespace : nativeNamespaces)
      if (slot.equals(namespace) || slot.startsWith(namespace + ":")) throw new SecurityException("Native-only credential slot");
    return slot;
  }

  /** Whether a renderer-nameable slot admits compare-and-exchange. */
  public boolean compareExchangeAllowed(String slot) {
    if (slot == null) return false;
    for (Pattern pattern : compareExchange) if (pattern.matcher(slot).matches()) return true;
    return false;
  }

  /** Whether writes and removals of this slot must hold a credential intent. */
  public boolean credentialSlot(String slot) {
    return slot != null && credentialSlots.contains(slot);
  }

  /** Regex quoting for an exact slot name in the compare-exchange list. */
  public static String exact(String slot) {
    return Pattern.quote(slot);
  }
}
