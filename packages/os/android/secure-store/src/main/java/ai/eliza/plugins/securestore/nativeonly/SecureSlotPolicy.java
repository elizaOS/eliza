// spec/os/android/secureStore.md, "The app view names only slots its consumer policy opens to it, and never a delegation slot"; spec/os/android/secureStore.md, "A slot is absent only when none of its files exists, and an unreadable slot is never treated as absent"; spec/os/android/secureStore.md, "A value above the current limit cannot grow beyond the value already stored"; spec/os/android/secureStore.md, "A compare-and-exchange changes a slot only when it holds exactly the expected value"; spec/os/android/secureStore.md, "A write is acknowledged only after it reads back exactly, and a removal only after every file of the slot is gone"
package ai.eliza.plugins.securestore.nativeonly;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

public final class SecureSlotPolicy {
  public static final int NAME_LIMIT = 1024;
  public static final int DEFAULT_LIMIT = 256 * 1024;
  public static final int MAXIMUM_LIMIT = Integer.MAX_VALUE - 64;
  public static final String DELEGATION_NAMESPACE = "cloud-delegation";
  public static final String SIGN_IN_NAMESPACE = "sign-in";
  public static final String DEEP_LINKS_NAMESPACE = "deep-links";
  public static final String TASK_KEYS_NAMESPACE = "task-data-key";
  public static final String CLOCK_DEVICE_SLOT = "native.clock_device";
  public static final List<String> NATIVE_ONLY_BY_DEFAULT =
      List.of(SIGN_IN_NAMESPACE, DEEP_LINKS_NAMESPACE, TASK_KEYS_NAMESPACE, CLOCK_DEVICE_SLOT);
  public static final SecureSlotPolicy DEFAULT = new SecureSlotPolicy(List.of(), List.of(), DEFAULT_LIMIT);

  public enum SlotAccess { NativeOnly, RendererWritable, RendererExchangeable }
  public enum SlotFamily { OrdinarySlot, DelegationSlot }
  public enum Caller { NativeCaller, RendererCaller }
  public enum SlotRequest { ReadRequest, WriteRequest, RemoveRequest, ExchangeRequest }
  public enum ExchangeOutcome { Written, Removed, Conflict, CapacityRefused, Refused, Failed, Unconfirmed }
  public enum PublicationReceipt { PendingReceipt, SuccessReceipt, FailureReceipt, UnknownReceipt }

  public record SlotRule(String slot, SlotFamily family, SlotAccess access, long limit, long retained) {}

  public sealed interface Frame permits NoFile, Unopenable, Rejected, Authentic {}
  public record NoFile() implements Frame {}
  public record Unopenable() implements Frame {}
  public record Rejected() implements Frame {}
  public record Authentic(long bytes) implements Frame {}

  public sealed interface SlotRead permits Absent, Unreadable, Value {}
  public record Absent() implements SlotRead {}
  public record Unreadable() implements SlotRead {}
  public record Value(long bytes) implements SlotRead {}

  public sealed interface Proposal permits RemoveValue, PutValue {}
  public record RemoveValue() implements Proposal {}
  public record PutValue(long bytes) implements Proposal {}

  public sealed interface Expectation permits Unconditional, ExpectAbsent, ExpectText {}
  public record Unconditional() implements Expectation {}
  public record ExpectAbsent() implements Expectation {}
  public record ExpectText(boolean sameAsStored) implements Expectation {}

  public sealed interface Verdict permits WriteFrame, EraseFrame, Answer {}
  public record WriteFrame() implements Verdict {}
  public record EraseFrame() implements Verdict {}
  public record Answer(ExchangeOutcome outcome) implements Verdict {}

  public sealed interface SlotExchange permits Ready, Writing, Removing, Answered {}
  public record Ready() implements SlotExchange {}
  public record Writing(String slot) implements SlotExchange {}
  public record Removing(String slot) implements SlotExchange {}
  public record Answered(String slot, ExchangeOutcome outcome) implements SlotExchange {}

  private record SlotClass(Pattern pattern, SlotAccess access, long limit, long retained) {}

  private final List<String> nativeOnly;
  private final List<SlotClass> classes;
  private final long defaultLimit;

  private SecureSlotPolicy(List<String> nativeOnly, List<SlotClass> classes, long defaultLimit) {
    List<String> namespaces = new ArrayList<>(NATIVE_ONLY_BY_DEFAULT);
    namespaces.addAll(nativeOnly);
    this.nativeOnly = List.copyOf(namespaces);
    this.classes = List.copyOf(classes);
    this.defaultLimit = defaultLimit;
  }

  public static boolean within(String name, String namespace) {
    return name.equals(namespace) || name.startsWith(namespace + ":");
  }

  public SlotRule rule(String name) {
    if (name == null || name.isEmpty() || name.length() > NAME_LIMIT) return null;
    if (within(name, DELEGATION_NAMESPACE))
      return new SlotRule(name, SlotFamily.DelegationSlot, SlotAccess.NativeOnly, defaultLimit, defaultLimit);
    SlotClass matched = null;
    for (SlotClass candidate : classes) if (candidate.pattern.matcher(name).matches()) { matched = candidate; break; }
    boolean nativeName = false;
    for (String namespace : nativeOnly) nativeName |= within(name, namespace);
    SlotAccess access = nativeName ? SlotAccess.NativeOnly : matched == null ? SlotAccess.RendererWritable : matched.access;
    return matched == null
        ? new SlotRule(name, SlotFamily.OrdinarySlot, access, defaultLimit, defaultLimit)
        : new SlotRule(name, SlotFamily.OrdinarySlot, access, matched.limit, matched.retained);
  }

  public static SecureSlotPolicy parse(Map<String, ?> config) {
    if (config == null) return DEFAULT;
    for (String key : config.keySet())
      if (!Set.of("nativeOnly", "slots", "defaultLimit").contains(key)) throw new IllegalArgumentException("Unknown secure slot policy field " + key);
    long defaultLimit = config.containsKey("defaultLimit") ? bytes(config.get("defaultLimit"), "defaultLimit") : DEFAULT_LIMIT;
    List<String> nativeOnly = new ArrayList<>();
    for (Object namespace : list(config.get("nativeOnly"), "nativeOnly")) {
      if (!(namespace instanceof String text) || text.isEmpty() || text.length() > NAME_LIMIT)
        throw new IllegalArgumentException("Invalid native-only namespace");
      nativeOnly.add(text);
    }
    List<SlotClass> classes = new ArrayList<>();
    for (Object entry : list(config.get("slots"), "slots")) {
      if (!(entry instanceof Map<?, ?> slot)) throw new IllegalArgumentException("Invalid secure slot class");
      for (Object key : slot.keySet())
        if (!Set.of("pattern", "access", "limit", "retained").contains(key)) throw new IllegalArgumentException("Unknown secure slot class field " + key);
      if (!(slot.get("pattern") instanceof String pattern) || pattern.isEmpty()) throw new IllegalArgumentException("Invalid secure slot pattern");
      SlotAccess access = switch (String.valueOf(slot.get("access"))) {
        case "nativeOnly" -> SlotAccess.NativeOnly;
        case "writable" -> SlotAccess.RendererWritable;
        case "exchangeable" -> SlotAccess.RendererExchangeable;
        default -> throw new IllegalArgumentException("Invalid secure slot access");
      };
      long limit = bytes(slot.get("limit"), "limit");
      long retained = slot.get("retained") == null ? limit : bytes(slot.get("retained"), "retained");
      if (retained < limit) throw new IllegalArgumentException("A secure slot's retained ceiling is below its limit");
      try {
        classes.add(new SlotClass(Pattern.compile(pattern), access, limit, retained));
      } catch (PatternSyntaxException invalid) {
        throw new IllegalArgumentException("Invalid secure slot pattern", invalid);
      }
    }
    return new SecureSlotPolicy(nativeOnly, classes, defaultLimit);
  }

  private static List<?> list(Object value, String field) {
    if (value == null) return List.of();
    if (!(value instanceof List<?> items)) throw new IllegalArgumentException("Invalid secure slot policy field " + field);
    return items;
  }

  private static long bytes(Object value, String field) {
    if (!(value instanceof Integer || value instanceof Long)) throw new IllegalArgumentException("Invalid secure slot " + field);
    long count = ((Number) value).longValue();
    if (count < 1 || count > MAXIMUM_LIMIT) throw new IllegalArgumentException("Invalid secure slot " + field);
    return count;
  }

  public static boolean budgetValid(SlotRule rule) {
    return rule.limit() >= 1 && rule.retained() >= rule.limit();
  }

  public static boolean admits(Caller caller, SlotRequest request, SlotRule rule) {
    return !rule.slot().isEmpty() && rule.family() == SlotFamily.OrdinarySlot && budgetValid(rule)
        && (caller == Caller.NativeCaller || (rule.access() != SlotAccess.NativeOnly
            && (request != SlotRequest.ExchangeRequest || rule.access() == SlotAccess.RendererExchangeable)));
  }

  public static SlotRead readFrame(Frame frame, SlotRule rule) {
    if (frame instanceof NoFile) return new Absent();
    if (frame instanceof Authentic authentic)
      return authentic.bytes() >= 1 && authentic.bytes() <= rule.retained() ? new Value(authentic.bytes()) : new Unreadable();
    return new Unreadable();
  }

  public static boolean mayInitialize(SlotRead observed) {
    return observed instanceof Absent;
  }

  public static long priorBytes(SlotRead observed) {
    return observed instanceof Value value ? value.bytes() : -1;
  }

  public static Verdict putVerdict(long bytes, SlotRule rule, SlotRead observed) {
    if (bytes < 1) return new Answer(ExchangeOutcome.Refused);
    if (bytes > rule.retained()) return new Answer(ExchangeOutcome.CapacityRefused);
    if (bytes > rule.limit() && observed instanceof Unreadable) return new Answer(ExchangeOutcome.Failed);
    if (bytes > rule.limit() && bytes > priorBytes(observed)) return new Answer(ExchangeOutcome.CapacityRefused);
    return new WriteFrame();
  }

  public static SlotRequest requestOf(Expectation expectation, Proposal proposal) {
    if (!(expectation instanceof Unconditional)) return SlotRequest.ExchangeRequest;
    return proposal instanceof RemoveValue ? SlotRequest.RemoveRequest : SlotRequest.WriteRequest;
  }

  public static boolean expectationHolds(Expectation expectation, SlotRead observed) {
    if (expectation instanceof Unconditional) return true;
    if (expectation instanceof ExpectAbsent) return observed instanceof Absent;
    return ((ExpectText) expectation).sameAsStored() && priorBytes(observed) >= 1;
  }

  public static Verdict verdict(Caller caller, SlotRule rule, Expectation expectation, Proposal proposal, SlotRead observed) {
    if (!admits(caller, requestOf(expectation, proposal), rule)) return new Answer(ExchangeOutcome.Refused);
    if (!(expectation instanceof Unconditional) && observed instanceof Unreadable) return new Answer(ExchangeOutcome.Failed);
    if (!expectationHolds(expectation, observed)) return new Answer(ExchangeOutcome.Conflict);
    if (proposal instanceof PutValue put) return putVerdict(put.bytes(), rule, observed);
    return new EraseFrame();
  }

  public static boolean inFlight(SlotExchange s) {
    return s instanceof Writing || s instanceof Removing;
  }

  public static boolean canBegin(SlotExchange s) {
    return !inFlight(s);
  }

  public static SlotExchange begin(SlotExchange s, Caller by, SlotRule rule, Expectation expectation, Proposal proposal, SlotRead observed) {
    Verdict decided = verdict(by, rule, expectation, proposal, observed);
    if (decided instanceof WriteFrame) return new Writing(rule.slot());
    if (decided instanceof EraseFrame) return new Removing(rule.slot());
    return new Answered(rule.slot(), ((Answer) decided).outcome());
  }

  public static boolean canSettleWrite(SlotExchange s, PublicationReceipt receipt) {
    return (receipt == PublicationReceipt.SuccessReceipt || receipt == PublicationReceipt.FailureReceipt) && s instanceof Writing;
  }

  public static SlotExchange settleWrite(SlotExchange s, PublicationReceipt receipt, boolean readBack) {
    if (!(s instanceof Writing writing)) return s;
    ExchangeOutcome outcome = receipt == PublicationReceipt.FailureReceipt ? ExchangeOutcome.Failed
        : readBack ? ExchangeOutcome.Written : ExchangeOutcome.Unconfirmed;
    return new Answered(writing.slot(), outcome);
  }

  public static boolean canSettleRemove(SlotExchange s) {
    return s instanceof Removing;
  }

  public static SlotExchange settleRemove(SlotExchange s, boolean allGone) {
    if (!(s instanceof Removing removing)) return s;
    return new Answered(removing.slot(), allGone ? ExchangeOutcome.Removed : ExchangeOutcome.Unconfirmed);
  }

  public static ExchangeOutcome outcomeOf(SlotExchange s) {
    return s instanceof Answered answered ? answered.outcome() : ExchangeOutcome.Unconfirmed;
  }
}
