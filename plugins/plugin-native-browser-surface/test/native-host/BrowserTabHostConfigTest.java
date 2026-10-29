import ai.eliza.plugins.browsersurface.BrowserAutofillExtras;
import ai.eliza.plugins.browsersurface.BrowserTabHostConfig;
import java.util.Arrays;

/** Plain-JVM checks for BrowserTabHostConfig: installed identities and the shared tab rules. */
public final class BrowserTabHostConfigTest {
  private static int assertions;
  private static final BrowserAutofillExtras EXTRAS = new BrowserAutofillExtras("field-origin", "top-origin");

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition) throw new AssertionError(message);
  }

  private static void equal(Object actual, Object expected, String message) {
    check(expected == null ? actual == null : expected.equals(actual),
        message + ": expected " + expected + " got " + actual);
  }

  private static void refused(Runnable action, String message) {
    try {
      action.run();
    } catch (IllegalArgumentException expected) {
      assertions++;
      return;
    }
    check(false, message + ": accepted");
  }

  /** The identity a host that already shipped keeps (names its earlier builds wrote). */
  private static BrowserTabHostConfig.Builder shipped() {
    return BrowserTabHostConfig.builder("product_browser_v1", "product_private_", "product-browser")
        .legacyEphemeralPrefix("product_public_")
        .names("Product Phone", "Product", "Product Browser")
        .hostScheme("productphone")
        .autofillExtras(EXTRAS);
  }

  public static void main(String[] args) {
    BrowserTabHostConfig c = shipped().build();
    // Store and registry names derive from the storage prefix unless the host names them.
    equal(c.downloadPreferences, "product-browser-downloads", "download list file");
    equal(c.retiredProfilePreferences, "product-browser-retired-profiles", "retired profile ledger");
    equal(c.noticePreferences, "product-browser-notices", "notice file");
    equal(c.registryKey("share"), "product-browser-share", "registry key");
    equal(c.registryKey("site-permission"), "product-browser-site-permission", "registry key with hyphen");
    refused(() -> c.registryKey("Share!"), "registry purpose is plain");
    equal(c.browserName, "Product Browser", "browser name");
    equal(c.maxTabs, 8, "default tab limit");
    check(c.hostSchemes.contains("productphone"), "host scheme kept");
    BrowserTabHostConfig named = shipped().downloadPreferences("legacy-downloads").build();
    equal(named.downloadPreferences, "legacy-downloads", "an installed download file name is kept");

    // Profile kinds.
    check(!c.ephemeral(c.persistentProfile), "persistent profile is durable");
    check(c.ephemeral("product_private_abc_t1"), "private profile is ephemeral");
    check(c.ephemeral("product_public_old"), "legacy per-tab profile is ephemeral");
    check(!c.ephemeral(null), "null is not a profile");
    check(!c.ephemeral("Default"), "Default is never ephemeral");
    check(c.admits("product_browser_v1", false), "normal tab uses the persistent profile");
    check(!c.admits("product_browser_v1", true), "private tab never uses the persistent profile");
    check(c.admits("product_private_abc_t1", true), "private tab uses a private profile");
    check(!c.admits("product_private_abc_t1", false), "normal tab never uses a private profile");
    check(!c.admits("Default", false) && !c.admits("Default", true), "Default is the host's");
    check(!c.admits(null, false), "null profile refused");
    check(!c.admits("product browser", false), "unsafe profile name refused");

    // Private namespaces and profiles.
    String namespace = c.newPrivateNamespace("0F8FAD5B-D9CB-469F-A165-70867728950E");
    equal(namespace, "product_private_0f8fad5bd9cb469fa16570867728950e", "namespace from a UUID");
    equal(c.privateProfile(namespace, "tab_1"), namespace + "_tab_1", "private profile name");
    check(c.admits(c.privateProfile(namespace, "b" + "a".repeat(79)), true), "longest tab id fits");
    refused(() -> c.newPrivateNamespace("short"), "weak namespace");
    refused(() -> c.privateProfile(namespace, "tab 1"), "unsafe tab id");
    refused(() -> c.privateProfile("product_browser_v1", "t"), "persistent profile is not a namespace");

    // Identity rules.
    refused(() -> BrowserTabHostConfig.builder("Default", "p_private_", "p").autofillExtras(EXTRAS).build(),
        "Default as persistent profile");
    refused(() -> BrowserTabHostConfig.builder("p_private_v1", "p_private_", "p").autofillExtras(EXTRAS).build(),
        "persistent profile under the private prefix");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "p_private_", "p").legacyEphemeralPrefix("p_").autofillExtras(EXTRAS).build(),
        "persistent profile under a legacy prefix");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "eliza-", "p").autofillExtras(EXTRAS).build(),
        "prefix would purge surface profiles");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "eliza-keyed-browser-tabs-", "p").autofillExtras(EXTRAS).build(),
        "prefix inside keyed surface profiles");
    refused(() -> BrowserTabHostConfig.builder("eliza-browser-tabs", "p_private_", "p").autofillExtras(EXTRAS).build(),
        "persistent profile the surface host purges");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "De", "p").autofillExtras(EXTRAS).build(),
        "prefix that matches Default");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "p_private_", "P").autofillExtras(EXTRAS).build(),
        "storage prefix is lower case");
    refused(() -> shipped().noticePreferences("product-browser-downloads").build(), "files are distinct");
    refused(() -> shipped().hostScheme("https").build(), "web scheme as host scheme");
    refused(() -> shipped().maxTabs(0).build(), "no tabs");
    refused(() -> shipped().maxTabs(BrowserTabHostConfig.MAX_TABS_LIMIT + 1).build(), "too many tabs");
    refused(() -> shipped().names("Product\nPhone", "Product", null).build(), "control in a name");
    refused(() -> BrowserTabHostConfig.builder("p_v1", "p_private_", "p").build(), "autofill extras required");
    check(BrowserTabHostConfig.builder("eliza_browser_v1", "eliza_private_", "eliza-browser-tabs")
        .names("Eliza", "Eliza", null).autofillExtras(EXTRAS).build().browserName.equals("Eliza Browser"),
        "a second product identity coexists with surface profiles");

    // Shared tab rules.
    check(BrowserTabHostConfig.validTabId("b0123abc_-") && !BrowserTabHostConfig.validTabId("../x"), "tab ids");
    check(BrowserTabHostConfig.captureType(new String[] {"image/*"}), "image input");
    check(BrowserTabHostConfig.captureType(new String[] {" .JPG "}), "image extension");
    check(!BrowserTabHostConfig.captureType(new String[] {"application/pdf"}), "document input");
    check(!BrowserTabHostConfig.captureType(null) && !BrowserTabHostConfig.captureType(new String[0]), "no accept");
    check(BrowserTabHostConfig.validFindQuery("a\tb"), "tab in query");
    check(!BrowserTabHostConfig.validFindQuery("a\nb"), "newline in query");
    char[] longQuery = new char[201];
    Arrays.fill(longQuery, 'q');
    check(!BrowserTabHostConfig.validFindQuery(new String(longQuery)), "long query");
    check(!BrowserTabHostConfig.validFindQuery(null), "null query");
    equal(BrowserTabHostConfig.realmLabel(" a\u0000b\u007f "), "a b", "realm controls");
    equal(BrowserTabHostConfig.realmLabel("r".repeat(150)).length(), 100, "realm length");
    equal(BrowserTabHostConfig.realmLabel(null), "", "no realm");
    check(c.passwordPage("https", "example.test"), "https password page");
    check(!c.passwordPage("http", "localhost"), "loopback http refused in production");
    BrowserTabHostConfig dev = shipped().allowLoopback(true).build();
    check(dev.passwordPage("http", "127.0.0.1") && dev.passwordPage("HTTP", "localhost"), "development loopback");
    check(!dev.passwordPage("http", "example.test"), "remote http refused in development");
    System.out.println(assertions + " assertions passed");
  }
}
