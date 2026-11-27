// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package com.getcapacitor;

public class Plugin {
  public static android.content.Context context;
  public static final androidx.appcompat.app.AppCompatActivity activity = new androidx.appcompat.app.AppCompatActivity();
  public static PermissionState permission = PermissionState.GRANTED;
  public android.content.Context getContext() { return context; }
  public androidx.appcompat.app.AppCompatActivity getActivity() { return activity; }
  public PermissionState getPermissionState(String alias) { return permission; }
  protected void requestPermissionForAlias(String alias, PluginCall call, String callback) { throw new AssertionError("A permission prompt was opened"); }
  protected void handleOnPause() {}
  protected void handleOnDestroy() {}
  @PluginMethod public void checkPermissions(PluginCall call) { call.resolve(new JSObject().put("calendar", permission == PermissionState.GRANTED ? "granted" : "denied")); }
  @PluginMethod public void requestPermissions(PluginCall call) { checkPermissions(call); }
}
