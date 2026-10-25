package ai.eliza.plugins.media;

import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Host configuration for owned-media storage. The host supplies its storage namespace and
 * MediaStore placement; the shared code never chooses product names or folders itself.
 * Pure Java so hosts and JVM tests can validate it without the Android framework.
 */
public final class OwnedMediaConfig {
  private static final Pattern NAMESPACE = Pattern.compile("[a-z][a-z0-9-]{0,39}");
  private static final Pattern PREFIX = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,31}");
  private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}");
  private static final Pattern OPERATION =
      Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");

  public final String storageNamespace;
  public final String editRelativePath;
  public final String editNamePrefix;
  public final String captureRelativePath;
  public final String captureNamePrefix;

  private OwnedMediaConfig(Builder builder) {
    storageNamespace = builder.namespace;
    editRelativePath = builder.editRelativePath;
    editNamePrefix = builder.editNamePrefix;
    captureRelativePath = builder.captureRelativePath;
    captureNamePrefix = builder.captureNamePrefix;
  }

  /** Starts a configuration for one host storage namespace, for example {@code "myapp"}. */
  public static Builder builder(String storageNamespace) {
    return new Builder(storageNamespace);
  }

  /** Host-namespaced SharedPreferences name for one shared-code purpose. */
  public String preferences(String purpose) {
    if (purpose == null || !NAMESPACE.matcher(purpose).matches())
      throw new IllegalArgumentException("Invalid preference purpose");
    return storageNamespace + "-" + purpose;
  }

  /** Deterministic owned display name for an edit copy; closes publish/receipt crash ambiguity. */
  public String editName(String operationId) {
    return editNamePrefix + operation(operationId) + ".png";
  }

  /** Deterministic owned display name for an explicitly kept capture. */
  public String captureName(String operationId) {
    return captureNamePrefix + operation(operationId) + ".jpg";
  }

  /** Accepts only a canonical lowercase UUID as an operation identity. */
  public static String operation(String token) {
    if (token == null || !OPERATION.matcher(token).matches()
        || !UUID.fromString(token).toString().equals(token))
      throw new IllegalArgumentException("Invalid save identity");
    return token;
  }

  static String relativePath(String value) {
    if (value == null || !value.endsWith("/"))
      throw new IllegalArgumentException("Relative path must end with /");
    String[] parts = value.substring(0, value.length() - 1).split("/", -1);
    if (!(parts[0].equals("Pictures") || parts[0].equals("DCIM")))
      throw new IllegalArgumentException("Owned media must live under Pictures/ or DCIM/");
    for (String part : parts)
      if (!SEGMENT.matcher(part).matches() || part.endsWith(".") || part.endsWith(" "))
        throw new IllegalArgumentException("Invalid relative path segment");
    return value;
  }

  public static final class Builder {
    private final String namespace;
    private String editRelativePath, editNamePrefix, captureRelativePath, captureNamePrefix;

    private Builder(String namespace) {
      if (namespace == null || !NAMESPACE.matcher(namespace).matches())
        throw new IllegalArgumentException("Invalid storage namespace");
      this.namespace = namespace;
    }
    /** MediaStore RELATIVE_PATH and display-name prefix for edit copies. */
    public Builder edits(String relativePath, String namePrefix) {
      editRelativePath = relativePath(relativePath);
      editNamePrefix = prefix(namePrefix);
      return this;
    }
    /** MediaStore RELATIVE_PATH and display-name prefix for explicitly kept captures. */
    public Builder captures(String relativePath, String namePrefix) {
      captureRelativePath = relativePath(relativePath);
      captureNamePrefix = prefix(namePrefix);
      return this;
    }
    public OwnedMediaConfig build() {
      if (editRelativePath == null || captureRelativePath == null)
        throw new IllegalStateException("Configure edits and captures");
      return new OwnedMediaConfig(this);
    }
    private static String prefix(String value) {
      if (value == null || !PREFIX.matcher(value).matches())
        throw new IllegalArgumentException("Invalid display-name prefix");
      return value;
    }
  }
}
