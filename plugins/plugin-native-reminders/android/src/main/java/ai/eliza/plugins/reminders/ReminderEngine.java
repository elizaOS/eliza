package ai.eliza.plugins.reminders;
import android.content.Context;
import android.content.Intent;
import java.util.*;
import org.json.*;
/** Process-lifetime singleton per canonical preference store. One process per store is required. */
public final class ReminderEngine {
 private static final Map<String,ReminderEngine> ENGINES=new HashMap<>();
 private static final Map<String,String> CLAIMS=new HashMap<>();
 final Context context; final ReminderStore store;private final String fingerprint;
 private ReminderEngine(Context context,ReminderConfiguration configuration,SecureStringStore secure,String fingerprint){this.context=context;this.store=new ReminderStore(configuration,secure);this.fingerprint=fingerprint;}
 public static synchronized ReminderEngine get(Context input,ReminderConfiguration configuration,SecureStringStore.Factory factory){
  Objects.requireNonNull(input);Objects.requireNonNull(configuration);Objects.requireNonNull(factory);
  Context context=input.getApplicationContext();if(context==null)context=input;
  if(input.isDeviceProtectedStorage()!=context.isDeviceProtectedStorage())throw new IllegalArgumentException("Storage-domain context must be preserved");
  final String data,key;try{data=context.getDataDir().getCanonicalPath();key=new java.io.File(context.getDataDir(),"shared_prefs/"+configuration.envelopeName+".xml").getCanonicalPath();}catch(java.io.IOException error){throw new IllegalStateException("Reminder storage identity unavailable",error);}
  SecureStringStore secure=Objects.requireNonNull(factory.create(context));String secureId=Objects.requireNonNull(secure.identity());if(secureId.isEmpty())throw new IllegalArgumentException("Secure storage identity required");
  String fingerprint=configuration.fingerprint()+"|"+new JSONArray(Arrays.asList(context.getPackageName(),secureId)).toString();ReminderEngine existing=ENGINES.get(key);
  if(existing!=null){if(!existing.fingerprint.equals(fingerprint))throw new IllegalStateException("Reminder identity configuration changed");return existing;}
  // IDs contain no colon, so empty legacy tags and distinct "namespace:" prefixes cannot collide.
  // Action ownership is conservative: sharing a component+action is rejected even with different URI prefixes.
  // Distinct stores cannot silently share taps, preference files, channels, tags or intent routes.
  String[] claims={context.getPackageName()+"|notification-tags|"+configuration.notificationTagPrefix,data+"|preferences|"+configuration.envelopeName,data+"|preferences|"+configuration.legacyName,data+"|legacy|"+configuration.legacyName,data+"|secure|"+secureId+"|"+configuration.tapSlot,context.getPackageName()+"|channel|"+configuration.channelId,context.getPackageName()+"|receiver-action|"+configuration.receiverClass.getName()+"|"+configuration.remindAction,context.getPackageName()+"|receiver-action|"+configuration.receiverClass.getName()+"|"+configuration.decisionAction,context.getPackageName()+"|activity-action|"+configuration.activityClass.getName()+"|"+configuration.openAction};
  for(String claim:claims)if(CLAIMS.containsKey(claim)&&!key.equals(CLAIMS.get(claim)))throw new IllegalStateException("Conflicting reminder resource ownership");
  ReminderEngine engine=new ReminderEngine(context,configuration,secure,fingerprint);ENGINES.put(key,engine);for(String claim:claims)CLAIMS.put(claim,key);return engine;
 }
 ReminderTaps taps(){return new ReminderTaps(context,store);}
 public synchronized void dispatch(Intent intent){if(intent==null)return;String action=intent.getAction();ReminderConfiguration c=store.configuration;
  if(Intent.ACTION_BOOT_COMPLETED.equals(action)||Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)||Intent.ACTION_TIME_CHANGED.equals(action)||Intent.ACTION_TIMEZONE_CHANGED.equals(action))store.restore(context);
  else if(c.remindAction.equals(action))store.deliver(context,intent.getStringExtra(c.idExtra),intent.getStringExtra(c.occurrenceExtra));
  else if(c.decisionAction.equals(action))try{store.decide(context,intent.getStringExtra(c.idExtra),intent.getStringExtra(c.occurrenceExtra),intent.getStringExtra(c.decisionExtra));}catch(RuntimeException|JSONException ignored){/* Persisted occurrence remains visible; no fabricated receipt. */}
 }
 public void restore(){store.restore(context);}
 public JSONArray list()throws JSONException{return store.list(context);}
 public JSONObject read(String id)throws JSONException{return store.read(context,id);}
 public JSONObject selected(String id)throws JSONException{return store.selected(context,id);}
 public JSONObject schedule(String id,String title,String body,long at,JSONObject recurrence,JSONObject timing)throws JSONException{return store.schedule(context,id,title,body,at,recurrence,timing);}
 public JSONObject decide(String id,String occurrence,String action)throws JSONException{return store.decide(context,id,occurrence,action);}
 public JSONObject operate(String id,String binding,JSONObject operation)throws JSONException{return store.operate(context,id,binding,operation);}
 public JSONObject operationReceipt(String id,String binding,JSONObject operation)throws JSONException{return store.operationReceipt(context,id,binding,operation);}
 public boolean notificationsAllowed(){return store.allowed(context);}
 public JSONObject pendingTap()throws Exception{return taps().pending();}
 public void captureTap(String token)throws Exception{taps().capture(token);}
 public JSONObject consumeTap(String token)throws Exception{return taps().consume(token);}
 public void dismissTap(String token)throws Exception{taps().dismiss(token);}
}
