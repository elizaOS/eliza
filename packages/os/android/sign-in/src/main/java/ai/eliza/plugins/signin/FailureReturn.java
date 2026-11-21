// spec/os/signIn/browserReturn.md, "Story: Come back to the app after a failed browser sign-in"
package ai.eliza.plugins.signin;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

public final class FailureReturn {
  private static final List<FailureReturn> REGISTERED = new CopyOnWriteArrayList<>();

  private final List<String> hosts;
  private final String path;

  public FailureReturn(List<String> hosts, String path) {
    if (hosts.isEmpty() || path == null || !path.startsWith("/")) throw new SignInRegistration.Refused("failure return");
    this.hosts = List.copyOf(hosts);
    this.path = path;
  }

  public static FailureReturn of(SignInRegistration registration, String path) {
    List<String> hosts = new ArrayList<>();
    for (SignInRegistration.Environment environment : registration.environments()) hosts.add(environment.appLinkHost);
    return new FailureReturn(hosts, path);
  }

  public static FailureReturn register(FailureReturn route) {
    REGISTERED.add(route);
    return route;
  }

  public boolean matches(Uri data) {
    return data != null && BrowserReturnPolicy.failureRoute(data.getScheme(), data.getHost(), data.getPath(), hosts, path);
  }

  public boolean consume(Intent intent) {
    if (intent == null || !matches(intent.getData())) return false;
    intent.setData(null);
    intent.setClipData(null);
    intent.replaceExtras((Bundle) null);
    intent.setAction(Intent.ACTION_MAIN);
    return true;
  }

  public static boolean consumeRegistered(Intent intent) {
    for (FailureReturn route : REGISTERED) if (route.consume(intent)) return true;
    return false;
  }

  public static boolean claims(String url) {
    Uri data = url == null ? null : Uri.parse(url);
    for (FailureReturn route : REGISTERED) if (route.matches(data)) return true;
    return false;
  }

  public static Intent mainIntent(Context context) {
    PackageManager packages = context.getPackageManager();
    String name = context.getPackageName();
    Intent launch = packages.getLaunchIntentForPackage(name);
    ComponentName main = launch == null ? null : launch.getComponent();
    if (main == null) {
      ResolveInfo home = packages.resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(name), 0);
      if (home == null || home.activityInfo == null) return null;
      main = new ComponentName(name, home.activityInfo.name);
    }
    return Intent.makeMainActivity(main).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  }
}
