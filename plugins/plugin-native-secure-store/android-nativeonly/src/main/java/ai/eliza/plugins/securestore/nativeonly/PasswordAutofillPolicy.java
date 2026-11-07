package ai.eliza.plugins.securestore.nativeonly;

import java.util.*;

/** Pure validation shared by the Android adapter and synthetic boundary tests. */
public class PasswordAutofillPolicy {
  public static final String VERSION = "ai.elizaresearch.autofill.version";
  public static final String ORIGIN = "ai.elizaresearch.autofill.origin";
  public static final String TOP_ORIGIN = "ai.elizaresearch.autofill.topOrigin";
  public static final String FIELD_ORIGIN = "ai.elizaresearch.autofill.fieldOrigin";
  public record Field(String origin, String scheme, String domain, List<String> hints, boolean visible, boolean focused) {}
  public static String validate(int version, String origin, String topOrigin, List<Field> fields) throws Exception {
    if (version != 1 || fields.size() != 2) throw new IllegalArgumentException("Unsupported form");
    String exact = PasswordVaultStore.origin(origin);
    if (!exact.equals(PasswordVaultStore.origin(topOrigin))) throw new IllegalArgumentException("Cross-origin frame");
    boolean username=false,password=false,focused=false;
    for (Field field:fields) {
      if (!field.visible() || !exact.equals(PasswordVaultStore.origin(field.origin())) || !"https".equals(field.scheme())) throw new IllegalArgumentException("Unsupported field origin");
      if (!new java.net.URI(exact).getHost().equalsIgnoreCase(field.domain())) throw new IllegalArgumentException("Inconsistent field origin");
      String role=role(field.hints());
      if (role.equals("username") && !username) username=true;
      else if (role.equals("password") && !password) password=true;
      else throw new IllegalArgumentException("Ambiguous fields");
      focused |= field.focused();
    }
    if (!username || !password || !focused) throw new IllegalArgumentException("No focused login");
    return exact;
  }
  public static String role(List<String> hints) {
    // Do not guess from labels or names controlled by page text; require explicit login hints.
    if (hints.size()!=1) return "";
    return switch(hints.get(0)) {case "username" -> "username"; case "current-password", "password" -> "password"; default -> "";};
  }
}
