package ai.eliza.plugins.phone;

import android.app.Activity;

/**
 * Host identity of the shared call surface. The channel ID is installed identity (Android keeps the
 * user's channel settings under it); the scheme only distinguishes notification actions per call.
 */
public final class TelecomCallConfiguration {
 public final String channelId, channelName, callScheme;
 public final Class<? extends Activity> callActivity;

 public TelecomCallConfiguration(String channelId, String channelName, String callScheme, Class<? extends Activity> callActivity) {
  if (channelId == null || !channelId.matches("[A-Za-z0-9_.-]{1,64}") || channelName == null || channelName.trim().isEmpty() || channelName.length() > 64
    || callScheme == null || !callScheme.matches("[a-z][a-z0-9+.-]{0,31}")) throw new IllegalArgumentException("Invalid call configuration");
  this.channelId = channelId; this.channelName = channelName; this.callScheme = callScheme;
  this.callActivity = java.util.Objects.requireNonNull(callActivity);
 }
}
