// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public class Context {
  public static final String KEYGUARD_SERVICE = "keyguard";
  public static final int MODE_PRIVATE = 0;
  public ContentResolver getContentResolver() { throw new AssertionError("No provider in this context"); }
  public Object getSystemService(String name) { return null; }
  public String getPackageName() { return "ai.eliza.fixture"; }
  public java.io.File getDataDir() { return new java.io.File("/fixture"); }
  public SharedPreferences getSharedPreferences(String name, int mode) { throw new AssertionError("No preferences in this context"); }
  public android.content.pm.PackageManager getPackageManager() { throw new AssertionError("No package manager in this context"); }
}
