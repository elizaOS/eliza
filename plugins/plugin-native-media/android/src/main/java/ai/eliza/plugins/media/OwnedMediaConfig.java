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
  /** MediaStore placement of video edit copies, or null when the host does not edit videos. */
  public final String videoEditRelativePath;
  public final String videoEditNamePrefix;

  private OwnedMediaConfig(Builder builder) {
    storageNamespace = builder.namespace;
    editRelativePath = builder.editRelativePath;
    editNamePrefix = builder.editNamePrefix;
    captureRelativePath = builder.captureRelativePath;
    captureNamePrefix = builder.captureNamePrefix;
    videoEditRelativePath = builder.videoEditRelativePath;
    videoEditNamePrefix = builder.videoEditNamePrefix;
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

  /**
   * Host-namespaced private directory or file-name stem for one shared-code purpose, for example
   * {@code "<namespace>-video-edits"} under the host's cache directory.
   */
  public String privateName(String purpose) {
    return preferences(purpose);
  }

  /** Deterministic owned display name for an edit copy; closes publish/receipt crash ambiguity. */
  public String editName(String operationId) {
    return editNamePrefix + operation(operationId) + ".png";
  }

  /** Deterministic owned display name for an explicitly kept capture. */
  public String captureName(String operationId) {
    return captureNamePrefix + operation(operationId) + ".jpg";
  }

  /** Deterministic owned display name for a video edit copy. */
  public String videoEditName(String operationId) {
    if (videoEditNamePrefix == null)
      throw new IllegalStateException("Configure video edits");
    return videoEditNamePrefix + operation(operationId) + ".mp4";
  }

  /** Accepts only a canonical lowercase UUID as an operation identity. */
  public static String operation(String token) {
    if (token == null || !OPERATION.matcher(token).matches()
        || !UUID.fromString(token).toString().equals(token))
      throw new IllegalArgumentException("Invalid save identity");
    return token;
  }

  static String relativePath(String value) {
    return relativePath(value, "Pictures", "DCIM");
  }

  static String relativePath(String value, String... roots) {
    if (value == null || !value.endsWith("/"))
      throw new IllegalArgumentException("Relative path must end with /");
    String[] parts = value.substring(0, value.length() - 1).split("/", -1);
    if (!java.util.Arrays.asList(roots).contains(parts[0]))
      throw new IllegalArgumentException(
          "Owned media must live under " + String.join("/ or ", roots) + "/");
    for (String part : parts)
      if (!SEGMENT.matcher(part).matches() || part.endsWith(".") || part.endsWith(" "))
        throw new IllegalArgumentException("Invalid relative path segment");
    return value;
  }

  public static final class Builder {
    private final String namespace;
    private String editRelativePath, editNamePrefix, captureRelativePath, captureNamePrefix;
    private String videoEditRelativePath, videoEditNamePrefix;

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
    /** Optional MediaStore RELATIVE_PATH (under Movies/ or DCIM/) and prefix for video copies. */
    public Builder videoEdits(String relativePath, String namePrefix) {
      videoEditRelativePath = relativePath(relativePath, "Movies", "DCIM");
      videoEditNamePrefix = prefix(namePrefix);
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
