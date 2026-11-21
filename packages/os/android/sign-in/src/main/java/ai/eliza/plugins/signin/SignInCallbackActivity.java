// spec/os/signIn/browserReturn.md, "The callback is one exported activity with its own exact App Link filter"; spec/os/signIn/browserReturn.md, "A failure-return link is consumed before the renderer and resumes the app with an empty main intent, also on a cold start"
package ai.eliza.plugins.signin;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class SignInCallbackActivity extends Activity {
  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    take(getIntent());
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    take(intent);
  }

  private void take(Intent intent) {
    if (intent != null && !FailureReturn.consumeRegistered(intent)) {
      Uri data = Intent.ACTION_VIEW.equals(intent.getAction()) ? intent.getData() : null;
      intent.setData(null);
      intent.setClipData(null);
      intent.replaceExtras((Bundle) null);
      if (data != null) BrowserSignIn.arrived(data.toString());
    }
    Intent main = FailureReturn.mainIntent(this);
    if (main != null) startActivity(main);
    finish();
  }
}
