package ai.eliza.auth.cloud;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The host application's registration with Eliza Cloud sign-in. The library owns the protocol;
 * the host supplies who it is (mobile App Auth client id, device label, product name, Steward app
 * client for native Google), which deployments it admits, and the installed names of its storage.
 * Existing installed names are compatibility identifiers: changing one abandons saved state.
 */
public final class CloudSignInConfig {
 /** Registered mobile App Auth client id, normally the Android package name. */
 public final String clientId;
 /** Device label recorded on the minted credential. */
 public final String deviceName;
 /** Product name shown in the authorization dialog. */
 public final String productName;
 /** Steward app client id for native Google sign-in. */
 public final String googleClientId;
 /** Tag of the one bounded Google diagnostic line. */
 public final String logTag;
 /** Plain preferences file that caches non-secret readiness. */
 public final String readinessPreferences;
 /** Native-only credential slot of a pending browser sign-in. */
 public final String pendingSlot;
 /** Native-only credential slot prefix of an acknowledgement receipt, per environment. */
 public final String receiptSlotPrefix;
 /** Credential slot prefix of the minted Cloud key, per environment. */
 public final String credentialSlotPrefix;
 private final List<CloudSignInEnvironment> environments;

 private CloudSignInConfig(Builder builder) {
  clientId = required(builder.clientId, "[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+", "client id");
  deviceName = label(builder.deviceName, "device name");
  productName = label(builder.productName, "product name");
  googleClientId = required(builder.googleClientId, "[a-z0-9][a-z0-9_-]{2,63}", "Google client id");
  logTag = required(builder.logTag, "[A-Za-z][A-Za-z0-9_]{0,22}", "log tag");
  readinessPreferences = required(builder.readinessPreferences, "[A-Za-z0-9._:-]{1,200}", "readiness preferences");
  pendingSlot = required(builder.pendingSlot, "[A-Za-z0-9._:-]{1,128}", "pending slot");
  receiptSlotPrefix = required(builder.receiptSlotPrefix, "[A-Za-z0-9._:-]{1,96}", "receipt slot prefix");
  credentialSlotPrefix = required(builder.credentialSlotPrefix, "[A-Za-z0-9._:-]{1,96}", "credential slot prefix");
  if (builder.environments.isEmpty()) throw new IllegalArgumentException("At least one Cloud environment is required");
  List<String> names = new ArrayList<>();
  for (CloudSignInEnvironment environment : builder.environments) {
   if (names.contains(environment.name)) throw new IllegalArgumentException("Duplicate Cloud environment " + environment.name);
   names.add(environment.name);
  }
  environments = Collections.unmodifiableList(new ArrayList<>(builder.environments));
 }
 private static String required(String value, String pattern, String label) {
  if (value == null || !value.matches(pattern)) throw new IllegalArgumentException("Invalid " + label);
  return value;
 }
 private static String label(String value, String label) {
  if (value == null || value.trim().isEmpty() || value.length() > 80 || !value.matches("[^\\p{Cc}\\p{Cf}]+")) throw new IllegalArgumentException("Invalid " + label);
  return value.trim();
 }

 /** Admitted deployments; the first is the default. */
 public List<CloudSignInEnvironment> environments() { return environments; }
 public CloudSignInEnvironment defaultEnvironment() { return environments.get(0); }
 /** The admitted deployment with this binding name. A name this build does not admit is refused. */
 public CloudSignInEnvironment environment(String name) {
  for (CloudSignInEnvironment environment : environments) if (environment.name.equals(name)) return environment;
  throw new IllegalArgumentException("Unsupported Cloud environment");
 }
 public String receiptSlot(CloudSignInEnvironment environment) { return receiptSlotPrefix + environment.name; }
 public String credentialSlot(CloudSignInEnvironment environment) { return credentialSlotPrefix + environment.name; }

 public static Builder builder() { return new Builder(); }
 public static final class Builder {
  private String clientId, deviceName, productName, googleClientId, logTag = "ElizaCloudSignIn";
  private String readinessPreferences = "eliza-cloud-signin-readiness", pendingSlot = "cloud-signin:v1:pending";
  private String receiptSlotPrefix = "cloud-signin:v1:ack:", credentialSlotPrefix = "cloud:";
  private final List<CloudSignInEnvironment> environments = new ArrayList<>();
  private Builder() {}
  public Builder clientId(String value) { clientId = value; return this; }
  public Builder deviceName(String value) { deviceName = value; return this; }
  public Builder productName(String value) { productName = value; return this; }
  public Builder googleClientId(String value) { googleClientId = value; return this; }
  public Builder logTag(String value) { logTag = value; return this; }
  public Builder readinessPreferences(String value) { readinessPreferences = value; return this; }
  public Builder pendingSlot(String value) { pendingSlot = value; return this; }
  public Builder receiptSlotPrefix(String value) { receiptSlotPrefix = value; return this; }
  public Builder credentialSlotPrefix(String value) { credentialSlotPrefix = value; return this; }
  public Builder environment(CloudSignInEnvironment value) { environments.add(value); return this; }
  public CloudSignInConfig build() { return new CloudSignInConfig(this); }
 }
}
