package ai.eliza.plugins.reminders;
import android.app.Activity;
import android.content.BroadcastReceiver;
/** All fields are migration-sensitive except human-readable labels. No request can override them. */
public final class ReminderConfiguration {
 public final String notificationTagPrefix;
 public final String envelopeName,legacyName,tapSlot,channelId,channelName,channelDescription,publicTitle;
 public final String remindAction,decisionAction,openAction,alarmUriPrefix,decisionUriPrefix,tapUriPrefix,idExtra,occurrenceExtra,decisionExtra;
 public final Class<? extends BroadcastReceiver> receiverClass;
 public final Class<? extends Activity> activityClass;
 public ReminderConfiguration(String envelopeName,String legacyName,String tapSlot,String channelId,String channelName,String channelDescription,String publicTitle,String remindAction,String decisionAction,String openAction,String alarmUriPrefix,String decisionUriPrefix,String tapUriPrefix,String idExtra,String occurrenceExtra,String decisionExtra,String notificationTagPrefix,Class<? extends BroadcastReceiver> receiverClass,Class<? extends Activity> activityClass){
  if(notificationTagPrefix==null||!notificationTagPrefix.matches("(?:[A-Za-z0-9_-]{1,100}:)?"))throw new IllegalArgumentException("Notification tag prefix must be empty or a namespace ending in colon");
  this.notificationTagPrefix=notificationTagPrefix;
  this.envelopeName=preference(envelopeName);this.legacyName=preference(legacyName);if(envelopeName.equals(legacyName)||bootMarkerName().equals(legacyName))throw new IllegalArgumentException("Distinct preference stores required");this.tapSlot=text(tapSlot);this.channelId=text(channelId);this.channelName=text(channelName);this.channelDescription=text(channelDescription);this.publicTitle=text(publicTitle);
  this.remindAction=text(remindAction);this.decisionAction=text(decisionAction);this.openAction=text(openAction);this.alarmUriPrefix=uri(alarmUriPrefix);this.decisionUriPrefix=uri(decisionUriPrefix);this.tapUriPrefix=uri(tapUriPrefix);this.idExtra=text(idExtra);this.occurrenceExtra=text(occurrenceExtra);this.decisionExtra=text(decisionExtra);this.receiverClass=java.util.Objects.requireNonNull(receiverClass);this.activityClass=java.util.Objects.requireNonNull(activityClass);
  if(new java.util.HashSet<>(java.util.Arrays.asList(remindAction,decisionAction,openAction)).size()!=3)throw new IllegalArgumentException("Distinct actions required");
  if(new java.util.HashSet<>(java.util.Arrays.asList(idExtra,occurrenceExtra,decisionExtra)).size()!=3)throw new IllegalArgumentException("Distinct extras required");
 }
 private static String text(String value){if(value==null||value.trim().isEmpty()||value.length()>1024||value.indexOf(0)>=0)throw new IllegalArgumentException("Invalid reminder configuration");return value;}
 private static String preference(String value){if(value==null||!value.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid reminder preference name");return value;}
 private static String uri(String value){text(value);if(!value.endsWith(":")&&!value.endsWith("/"))throw new IllegalArgumentException("URI prefix must end at a separator");android.net.Uri parsed=android.net.Uri.parse(value+"probe");if(parsed.getScheme()==null||parsed.getQuery()!=null||parsed.getFragment()!=null)throw new IllegalArgumentException("Invalid reminder URI prefix");return value;}
 String notificationTag(String id){return notificationTagPrefix+id;}
 /** Derived high-importance channel for due reminders; the configured channel remains for compatibility. */
 public String dueChannelId(){return channelId+"-due";}
 String bootMarkerName(){return envelopeName+"_restored_boot";}
 String fingerprint(){return new org.json.JSONArray(java.util.Arrays.asList(notificationTagPrefix,envelopeName,legacyName,tapSlot,channelId,channelName,channelDescription,publicTitle,remindAction,decisionAction,openAction,alarmUriPrefix,decisionUriPrefix,tapUriPrefix,idExtra,occurrenceExtra,decisionExtra,receiverClass.getName(),activityClass.getName())).toString();}
}
