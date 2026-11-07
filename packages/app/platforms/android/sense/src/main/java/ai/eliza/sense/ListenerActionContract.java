package ai.eliza.sense;

/** Versioned hint for SystemUI to locate the existing immutable Pause capability.
 * A marker alone is not authority: SystemUI must verify the image-pinned signer, notification
 * owner and PendingIntent creator/type/immutability before sending the token without fill-in data.
 */
final class ListenerActionContract {
 static final String KEY=BuildConfig.APPLICATION_ID+".SYSTEMUI_ACTION_V1";
 static final String PAUSE="pause-until-resumed";
 static String marker(String action){
  return (BuildConfig.APPLICATION_ID+".action.PAUSE").equals(action)?PAUSE:null;
 }
 private ListenerActionContract(){}
}
