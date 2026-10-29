package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The installed identity of a {@link BrowserTabHostPlugin}: WebView profile names, preference
 * files, activity-result keys and the product names its prompts use. Everything else (the tab
 * model, the profiles' lifetimes, pop-ups, app links, clearing, find, reading, autofill binding) is
 * the shared host's.
 *
 * <p>Names are compatibility identifiers. A host that already shipped keeps the names its earlier
 * builds wrote, so the persistent profile (website sign-ins), download history, retired-profile
 * ledger and one-time notices stay readable after it adopts the shared host. Changing a name starts
 * a new, empty profile or store; nothing is migrated.
 *
 * <p>Profile rules are checked here, before any WebView exists. The persistent normal-tab profile is
 * never Android's {@code Default} (the host document's) and never matches a prefix whose profiles
 * are deleted at startup. No tab-host prefix may overlap {@link BrowserProfilePolicy}'s isolated or
 * keyed surface profiles: either host's startup cleanup would otherwise delete the other's data.
 * Pure JVM.
 */
public final class BrowserTabHostConfig {
  /** Android WebView's profile for the host document; a browser tab never uses it. */
  public static final String DEFAULT_PROFILE = "Default";
  /** The most tabs (including pop-ups) one host keeps at once. */
  public static final int MAX_TABS_LIMIT = 16;

  private static final String PROFILE = "[A-Za-z0-9_-]{1,64}";
  private static final String PREFIX = "[A-Za-z0-9_-]{1,48}";
  private static final String FILE = "[A-Za-z0-9._-]{1,64}";
  private static final String SCHEME = "[a-z][a-z0-9+.-]{0,31}";

  /** One persistent profile for every normal tab: website sign-ins survive close and restart. */
  public final String persistentProfile;
  /** Private tabs get {@code privatePrefix + namespace + "_" + tabId}; purged on close and at start. */
  public final String privatePrefix;
  /** Ephemeral prefixes earlier builds used; their leftovers are purged at start like private ones. */
  public final List<String> legacyEphemeralPrefixes;
  /** Prefix of activity-result keys and camera file names (for example {@code alpha-browser}). */
  public final String storagePrefix;
  /** Preference file of the download list. */
  public final String downloadPreferences;
  /** Preference file recording private profiles awaiting deletion. */
  public final String retiredProfilePreferences;
  /** Preference file of once-per-install notices. */
  public final String noticePreferences;
  /** Application name in Android permission notices ("Android has not allowed …"). */
  public final String appName;
  /** Short product name in prompts ("… does not keep this password", "… before leaving …"). */
  public final String hostName;
  /** Browser name in notices ("Passkeys are not supported in …"). */
  public final String browserName;
  /** The host's own URL schemes: an {@code intent:} link may never carry them. */
  public final Set<String> hostSchemes;
  /** Autofill extra keys of the host's password provider (engine-bound field and top-level origins). */
  public final BrowserAutofillExtras autofillExtras;
  /** Development builds only: plain-http loopback pages may prompt, read and download. */
  public final boolean allowLoopback;
  /** Log main-frame failure codes (never addresses). */
  public final boolean debugLogging;
  public final int maxTabs;
  /** Log tag for the few diagnostic lines the host writes. */
  public final String logTag;

  private BrowserTabHostConfig(Builder b) {
    persistentProfile = b.persistentProfile;
    privatePrefix = b.privatePrefix;
    legacyEphemeralPrefixes = Collections.unmodifiableList(new ArrayList<>(b.legacyEphemeralPrefixes));
    storagePrefix = b.storagePrefix;
    downloadPreferences = b.downloadPreferences != null ? b.downloadPreferences : storagePrefix + "-downloads";
    retiredProfilePreferences = b.retiredProfilePreferences != null
        ? b.retiredProfilePreferences : storagePrefix + "-retired-profiles";
    noticePreferences = b.noticePreferences != null ? b.noticePreferences : storagePrefix + "-notices";
    appName = b.appName;
    hostName = b.hostName;
    browserName = b.browserName != null ? b.browserName : b.hostName + " Browser";
    hostSchemes = Collections.unmodifiableSet(new LinkedHashSet<>(b.hostSchemes));
    autofillExtras = b.autofillExtras;
    allowLoopback = b.allowLoopback;
    debugLogging = b.debugLogging;
    maxTabs = b.maxTabs;
    logTag = b.logTag != null ? b.logTag : "BrowserTabHost";
    validate();
  }

  public static Builder builder(String persistentProfile, String privatePrefix, String storagePrefix) {
    return new Builder(persistentProfile, privatePrefix, storagePrefix);
  }

  /** Whether {@code name} is one of this host's ephemeral (private or legacy per-tab) profiles. */
  public boolean ephemeral(String name) {
    if (name == null) return false;
    if (name.startsWith(privatePrefix)) return true;
    for (String prefix : legacyEphemeralPrefixes) if (name.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Whether a tab of the given kind may use {@code profile}: never the host's Default profile, a
   * private tab only an ephemeral one and a normal tab only a durable one.
   */
  public boolean admits(String profile, boolean privateTab) {
    return profile != null && !DEFAULT_PROFILE.equals(profile) && profile.matches("[A-Za-z0-9_-]{1,200}")
        && privateTab == ephemeral(profile);
  }

  /** A fresh private namespace for one host document; never reused after a reset. */
  public String newPrivateNamespace(String random) {
    String value = random == null ? "" : random.replace("-", "").toLowerCase(Locale.ROOT);
    if (!value.matches("[a-z0-9]{16,64}")) throw new IllegalArgumentException("namespace");
    return privatePrefix + value;
  }

  /** The private profile of {@code tabId} in {@code namespace} (from {@link #newPrivateNamespace}). */
  public String privateProfile(String namespace, String tabId) {
    if (namespace == null || !namespace.startsWith(privatePrefix) || !validTabId(tabId))
      throw new IllegalArgumentException("private profile");
    return namespace + "_" + tabId;
  }

  /** The activity-result registry key of one host launcher ({@code share}, {@code file}, …). */
  public String registryKey(String purpose) {
    if (purpose == null || !purpose.matches("[a-z-]{1,40}")) throw new IllegalArgumentException("purpose");
    return storagePrefix + "-" + purpose;
  }

  // ---- Shared tab rules -------------------------------------------------------------

  /** Renderer-chosen tab ids and host-made pop-up ids. */
  public static boolean validTabId(String id) {
    return BrowserSessionPolicy.validTabId(id);
  }

  /** Find-in-page text: at most 200 characters, tabs allowed, no other control characters. */
  public static boolean validFindQuery(String query) {
    return query != null && query.length() <= 200 && query.chars().noneMatch(c -> c < 32 && c != 9);
  }

  /** Whether a file input asks for an image, so a camera capture may be offered. */
  public static boolean captureType(String[] accept) {
    if (accept == null || accept.length == 0) return false;
    for (String type : accept)
      if (type != null) {
        String value = type.trim().toLowerCase(Locale.ROOT);
        if (value.startsWith("image/") || value.matches("\\.(jpe?g|png|webp|heic)")) return true;
      }
    return false;
  }

  /** A site's HTTP authentication realm as prompt text: controls removed, at most 100 characters. */
  public static String realmLabel(String realm) {
    String label = realm == null ? "" : realm.replaceAll("[\\x00-\\x1f\\x7f]", " ").trim();
    return label.length() > 100 ? label.substring(0, 100) : label;
  }

  /**
   * A page that may receive an HTTP password: HTTPS, or (development builds with {@link
   * #allowLoopback}) plain HTTP on 127.0.0.1 or localhost.
   */
  public boolean passwordPage(String scheme, String host) {
    if ("https".equalsIgnoreCase(scheme)) return true;
    return allowLoopback && "http".equalsIgnoreCase(scheme)
        && ("127.0.0.1".equals(host) || "localhost".equals(host));
  }

  private void validate() {
    require(persistentProfile != null && persistentProfile.matches(PROFILE)
        && !DEFAULT_PROFILE.equalsIgnoreCase(persistentProfile), "persistentProfile");
    require(privatePrefix != null && privatePrefix.matches(PREFIX), "privatePrefix");
    List<String> prefixes = new ArrayList<>();
    prefixes.add(privatePrefix);
    for (String prefix : legacyEphemeralPrefixes) {
      require(prefix != null && prefix.matches(PREFIX), "legacyEphemeralPrefixes");
      prefixes.add(prefix);
    }
    require(!ephemeral(persistentProfile), "persistentProfile must not be ephemeral");
    for (String prefix : prefixes)
      require(!"default".startsWith(prefix.toLowerCase(Locale.ROOT)), "prefix matches Default");
    String[] surface = {BrowserProfilePolicy.EPHEMERAL_PREFIX, BrowserProfilePolicy.KEYED_PREFIX};
    for (String other : surface) {
      require(!persistentProfile.startsWith(other), "persistentProfile overlaps surface profiles");
      for (String prefix : prefixes)
        require(!prefix.startsWith(other) && !other.startsWith(prefix), "prefix overlaps surface profiles");
    }
    require(storagePrefix != null && storagePrefix.matches("[a-z0-9][a-z0-9-]{0,39}"), "storagePrefix");
    for (String file : new String[] {downloadPreferences, retiredProfilePreferences, noticePreferences})
      require(file != null && file.matches(FILE), "preference file");
    require(new LinkedHashSet<>(List.of(downloadPreferences, retiredProfilePreferences, noticePreferences)).size() == 3,
        "preference files must be distinct");
    for (String name : new String[] {appName, hostName, browserName, logTag})
      require(name != null && !name.isBlank() && name.length() <= 40 && name.chars().noneMatch(c -> c < 32 || c == 127),
          "name");
    for (String scheme : hostSchemes)
      require(scheme != null && scheme.matches(SCHEME) && !scheme.equals("http") && !scheme.equals("https"),
          "hostSchemes");
    require(autofillExtras != null, "autofillExtras");
    require(maxTabs >= 1 && maxTabs <= MAX_TABS_LIMIT, "maxTabs");
  }

  private static void require(boolean condition, String field) {
    if (!condition) throw new IllegalArgumentException("Invalid browser tab host config: " + field);
  }

  public static final class Builder {
    private final String persistentProfile, privatePrefix, storagePrefix;
    private final List<String> legacyEphemeralPrefixes = new ArrayList<>();
    private final Set<String> hostSchemes = new LinkedHashSet<>();
    private String downloadPreferences, retiredProfilePreferences, noticePreferences;
    private String appName = "this app", hostName = "this app", browserName, logTag;
    private BrowserAutofillExtras autofillExtras;
    private boolean allowLoopback, debugLogging;
    private int maxTabs = 8;

    private Builder(String persistentProfile, String privatePrefix, String storagePrefix) {
      this.persistentProfile = persistentProfile;
      this.privatePrefix = privatePrefix;
      this.storagePrefix = storagePrefix;
    }

    public Builder legacyEphemeralPrefix(String prefix) { legacyEphemeralPrefixes.add(prefix); return this; }
    public Builder downloadPreferences(String name) { downloadPreferences = name; return this; }
    public Builder retiredProfilePreferences(String name) { retiredProfilePreferences = name; return this; }
    public Builder noticePreferences(String name) { noticePreferences = name; return this; }
    /** Application, short product and browser names used in prompts and notices. */
    public Builder names(String appName, String hostName, String browserName) {
      this.appName = appName; this.hostName = hostName; this.browserName = browserName; return this;
    }
    public Builder hostScheme(String scheme) { hostSchemes.add(scheme); return this; }
    public Builder autofillExtras(BrowserAutofillExtras extras) { autofillExtras = extras; return this; }
    public Builder allowLoopback(boolean allow) { allowLoopback = allow; return this; }
    public Builder debugLogging(boolean enabled) { debugLogging = enabled; return this; }
    public Builder maxTabs(int tabs) { maxTabs = tabs; return this; }
    public Builder logTag(String tag) { logTag = tag; return this; }
    public BrowserTabHostConfig build() { return new BrowserTabHostConfig(this); }
  }
}
