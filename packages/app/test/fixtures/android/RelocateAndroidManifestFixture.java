/**
 * Rewrites the real bundletool feature fixture into a privileged relocated-component adversary.
 */

import com.android.aapt.Resources;
import java.nio.file.Files;
import java.nio.file.Path;

public final class RelocateAndroidManifestFixture {
  private static final String ANDROID_NAMESPACE =
      "http://schemas.android.com/apk/res/android";
  private static final String ORIGINAL_CLASS = "JavaSampleActivity";
  private static final String RELOCATED_CLASS =
      "com.feature.relocated.security.component.abc.ElizaAccessibilityService";
  private static final String FORBIDDEN_PERMISSION =
      "android.permission.BIND_ACCESSIBILITY_SERVICE";

  private static Resources.XmlNode rewriteNode(Resources.XmlNode node) {
    if (!node.hasElement()) {
      return node;
    }

    Resources.XmlElement.Builder element = node.getElement().toBuilder();
    for (int index = 0; index < element.getChildCount(); index += 1) {
      element.setChild(index, rewriteNode(element.getChild(index)));
    }

    boolean target = element.getAttributeList().stream()
        .anyMatch(
            attribute ->
                attribute.getNamespaceUri().equals(ANDROID_NAMESPACE)
                    && attribute.getName().equals("name")
                    && attribute.getValue().endsWith("." + ORIGINAL_CLASS));
    if (target) {
      element.setName("service");
      for (int index = element.getAttributeCount() - 1; index >= 0; index -= 1) {
        Resources.XmlAttribute attribute = element.getAttribute(index);
        if (attribute.getNamespaceUri().equals(ANDROID_NAMESPACE)
            && attribute.getName().equals("splitName")) {
          element.removeAttribute(index);
        } else if (attribute.getNamespaceUri().equals(ANDROID_NAMESPACE)
            && attribute.getName().equals("name")) {
          element.setAttribute(index, attribute.toBuilder().setValue(RELOCATED_CLASS));
        }
      }
      element.addAttribute(
          Resources.XmlAttribute.newBuilder()
              .setNamespaceUri(ANDROID_NAMESPACE)
              .setName("permission")
              .setResourceId(0x01010006)
              .setValue(FORBIDDEN_PERMISSION));
    }

    return node.toBuilder().setElement(element).build();
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 2) {
      throw new IllegalArgumentException("expected input and output manifest paths");
    }
    Resources.XmlNode manifest = Resources.XmlNode.parseFrom(Files.readAllBytes(Path.of(args[0])));
    Files.write(Path.of(args[1]), rewriteNode(manifest).toByteArray());
  }
}
