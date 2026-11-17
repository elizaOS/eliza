package ai.eliza.plugins.messages;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

/**
 * The on-device half of the AOSP image capability that packages/os/scripts/android/image-capability.mjs
 * stages: whether this install is the host inside its own AOSP image. Image-only surfaces (Phone,
 * Contacts, SMS/MMS) ask {@link #admitted(Context)}; it is also a {@link SmsTelephonyConfiguration.Admission}.
 *
 * <p>Every fact is required and none implies another:
 * <ul>
 *  <li>the host's launcher build, a release (not debuggable) build, without the test-mocks switch;</li>
 *  <li>{@code FLAG_SYSTEM}: installed from a system partition, or an update of that preinstalled app,
 *      which Android accepts only with the same signer. A sideloaded or store install never has it;</li>
 *  <li>for a presigned host, its provisioning boolean, which defaults to false in a
 *      {@code system|product} overlayable and only the image's static product overlay sets;</li>
 *  <li>for {@link #admitted(Context)}, the image system feature {@code <package>.aosp_image}, version
 *      {@link #FEATURE_VERSION} or later, from the product permissions file the image stages.</li>
 * </ul>
 * HOME role or launcher flavor alone is never proof: the same APK can be sideloaded onto any phone.
 * Nothing the renderer, a URL, saved state or an agent sends can change the answer. An unreadable fact
 * counts as absent.
 */
public final class ImageCapability implements SmsTelephonyConfiguration.Admission {
 /** Minimum version of the image feature; matches IMAGE_FEATURE_VERSION in image-capability.mjs. */
 public static final int FEATURE_VERSION = 1;
 private static final String PACKAGE = "[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+";

 private final boolean launcherBuild, debugBuild, testMocks;
 private final int provisioningResource;
 private Boolean imageFacts;

 /**
  * @param provisioningResource the host's boolean provisioning resource id for a presigned host whose
  *     image enables it with a product overlay, or 0 for a host built only for its image (the system
  *     install and the image feature then decide alone).
  */
 public ImageCapability(boolean launcherBuild, boolean debugBuild, boolean testMocks, int provisioningResource) {
  if (provisioningResource < 0) throw new IllegalArgumentException("Invalid provisioning resource");
  this.launcherBuild = launcherBuild;
  this.debugBuild = debugBuild;
  this.testMocks = testMocks;
  this.provisioningResource = provisioningResource;
 }

 /** The system feature an image declares for {@code packageName}. */
 public static String featureName(String packageName) {
  if (packageName == null || !packageName.matches(PACKAGE)) throw new IllegalArgumentException("Invalid package");
  return packageName + ".aosp_image";
 }

 /** The decision over the observed facts. */
 public static boolean admitted(boolean launcherBuild, boolean debugBuild, boolean testMocks, boolean systemInstalled,
   boolean provisioned, boolean imageFeature) {
  return launcherBuild && !debugBuild && !testMocks && systemInstalled && provisioned && imageFeature;
 }

 /**
  * A provisioned release of the launcher installed from a system partition, without reading the image
  * feature. Surfaces that only need the image provisioning (for example contacts) use this; telephony
  * uses {@link #admitted(Context)}.
  */
 public boolean provisioned(Context context) {
  if (!launcherBuild || debugBuild || testMocks || context == null) return false;
  try {
   return systemInstalled(context) && (provisioningResource == 0 || context.getResources().getBoolean(provisioningResource));
  } catch (RuntimeException unavailable) {
   return false;
  }
 }

 /** The full image admission. Installation flags and system features do not change while a process runs, so they are read once. */
 @Override public boolean admitted(Context context) {
  if (!provisioned(context)) return false;
  synchronized (this) {
   if (imageFacts == null) {
    Context app = context.getApplicationContext() == null ? context : context.getApplicationContext();
    boolean feature;
    try {
     PackageManager packages = app.getPackageManager();
     feature = systemInstalled(app) && packages != null && packages.hasSystemFeature(featureName(app.getPackageName()), FEATURE_VERSION);
    } catch (RuntimeException unreadable) {
     feature = false;
    }
    imageFacts = feature;
   }
   return imageFacts;
  }
 }

 private static boolean systemInstalled(Context context) {
  ApplicationInfo info = context.getApplicationInfo();
  return info != null && (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
 }
}
