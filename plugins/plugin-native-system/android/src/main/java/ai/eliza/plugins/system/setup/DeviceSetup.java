package ai.eliza.plugins.system.setup;

import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.*;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Read-only readiness and user-requested settings navigation. No credential access or silent defaults. */
public final class DeviceSetup {
 public interface BrowserTrust { boolean isTrusted(String packageName,String certificate); }
 public enum Target { BROWSER_DEFAULTS, CREDENTIAL_PROVIDERS, BROWSER_APP, PASSWORD_MANAGER_APP, APP_DETAILS }
 public enum Outcome { OPENED, UNSUPPORTED_BROWSER, UNSUPPORTED_PASSWORD_MANAGER, UNSUPPORTED_PACKAGE, UNAVAILABLE }
 private final Context context;
 private final Set<String> browsers,passwordManagers;
 private final String selectedBrowser,certificate;
 private final BrowserTrust trust;
 private final Consumer<Intent> launch;
 public DeviceSetup(Context context,Set<String> browsers,Set<String> passwordManagers,String selectedBrowser,String certificate,BrowserTrust trust,Consumer<Intent> launch) {
  this.context=Objects.requireNonNull(context);
  this.browsers=Collections.unmodifiableSet(new LinkedHashSet<>(browsers));
  this.passwordManagers=Collections.unmodifiableSet(new LinkedHashSet<>(passwordManagers));
  this.selectedBrowser=Objects.requireNonNull(selectedBrowser);this.certificate=Objects.requireNonNull(certificate);
  this.trust=Objects.requireNonNull(trust);this.launch=Objects.requireNonNull(launch);
 }
 private boolean installed(String packageName) {
  try {
   context.getPackageManager().getPackageInfo(packageName, 0);
   return true;
  } catch (PackageManager.NameNotFoundException ignored) {
   return false;
  }
 }

 private org.json.JSONArray installedFrom(Set<String> packages) {
  org.json.JSONArray values = new org.json.JSONArray();
  for (String packageName : packages) if (installed(packageName)) values.put(packageName);
  return values;
 }

 private String selectedAutofillPackage() {
  String component = Settings.Secure.getString(context.getContentResolver(), "autofill_service");
  if (component == null || component.trim().isEmpty()) return null;
  ComponentName name = ComponentName.unflattenFromString(component);
  return name == null ? null : name.getPackageName();
 }

 private String defaultBrowserPackage() {
  Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.invalid/"));
  android.content.pm.ResolveInfo resolved = context.getPackageManager().resolveActivity(web, PackageManager.MATCH_DEFAULT_ONLY);
  return resolved == null || resolved.activityInfo == null ? null : resolved.activityInfo.packageName;
 }

 private String browserDispatchStatus() {
  String selected = selectedBrowser;
  if (certificate.isEmpty()) return "not-configured";
  if (!installed(selected)) return "not-installed";
  if (Build.VERSION.SDK_INT < 28 || !trust.isTrusted(selected, certificate)) return "untrusted";
  Intent service = new Intent("android.support.customtabs.action.CustomTabsService").setPackage(selected);
  Intent page = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.invalid/")).setPackage(selected);
  if (context.getPackageManager().resolveService(service, 0) == null ||
      context.getPackageManager().resolveActivity(page, PackageManager.MATCH_DEFAULT_ONLY) == null) return "unavailable";
  return "ready";
 }

 public JSONObject readiness() throws org.json.JSONException {
  String autofill = selectedAutofillPackage();
  String browser = defaultBrowserPackage();
  JSONObject result = new JSONObject();
  result.put("installedBrowsers", installedFrom(browsers));
  result.put("configuredBrowserPackage", selectedBrowser);
  result.put("browserDispatchStatus", browserDispatchStatus());
  result.put("browserObservationAvailable", false);
  result.put("installedPasswordManagers", installedFrom(passwordManagers));
  result.put("preferredBrowserPackage", browser == null ? JSONObject.NULL : browser);
  result.put("preferredBrowserIsSupported", browser != null && browsers.contains(browser));
  result.put("autofillProviderPackage", autofill == null ? JSONObject.NULL : autofill);
  result.put("autofillProviderIsSupported", autofill != null && passwordManagers.contains(autofill));
  // Android does not expose a general, nonprivileged API that proves a provider
  // is unlocked, synced, or ready for a particular website origin.
  result.put("providerVaultReadinessKnown", false);
  result.put("canChangeDefaultsSilently", false);
  return result;
 }

 private boolean start(Intent intent) {
  try {
   if (intent.resolveActivity(context.getPackageManager()) == null) return false;
   // Settings and other apps belong in their own task. Started inside this
   // (possibly HOME-role) task, Android 17 tablets leave this activity
   // resumed instead of showing the requested screen.
   launch.accept(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
   return true;
  } catch (RuntimeException ignored) {
   return false;
  }
 }

 private Intent packageLaunch(String packageName) {
  if (!installed(packageName)) return null;
  return context.getPackageManager().getLaunchIntentForPackage(packageName);
 }

 public Outcome open(Target target,String packageName) {
  Intent intent = null;
  switch (target) {
   case BROWSER_DEFAULTS: intent = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS); break;
   case CREDENTIAL_PROVIDERS: intent = Build.VERSION.SDK_INT >= 34 ? new Intent(Settings.ACTION_CREDENTIAL_PROVIDER) : null; break;
   case BROWSER_APP:
    if (packageName == null || !browsers.contains(packageName)) return Outcome.UNSUPPORTED_BROWSER;
    intent = packageLaunch(packageName); break;
   case PASSWORD_MANAGER_APP:
    if (packageName == null || !passwordManagers.contains(packageName)) return Outcome.UNSUPPORTED_PASSWORD_MANAGER;
    intent = packageLaunch(packageName); break;
   case APP_DETAILS:
    if (packageName == null || !(browsers.contains(packageName) || passwordManagers.contains(packageName)) || !installed(packageName)) return Outcome.UNSUPPORTED_PACKAGE;
    intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName)); break;
  }
  if (intent != null && start(intent)) return Outcome.OPENED;
  if (target == Target.CREDENTIAL_PROVIDERS && start(new Intent(Settings.ACTION_SETTINGS))) return Outcome.OPENED;
  return Outcome.UNAVAILABLE;
 }
}
