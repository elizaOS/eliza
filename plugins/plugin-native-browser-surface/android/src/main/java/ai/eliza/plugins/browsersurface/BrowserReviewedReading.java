package ai.eliza.plugins.browsersurface;

import android.app.AlertDialog;
import android.widget.ScrollView;
import android.widget.TextView;
import android.webkit.WebView;
import com.getcapacitor.*;
import java.util.Objects;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * One foreground, immutable, explicitly reviewed page excerpt for a {@link BrowserTabHostPlugin}.
 * No remote-page bridge: the text comes from the tab's {@link BrowserReadingWorld} and is shown in
 * full before the person releases it, either to a question editor or, bound to one speech route,
 * owner and session, to a single speech request that consumes it once.
 *
 * <p>The sensitive-address refusal, the extraction script and the reject codes are the shared
 * {@link BrowserPageReading} policy. The heuristic is not a credential detector: a blocked page has
 * no bypass.
 */
public final class BrowserReviewedReading {
 private final android.app.Activity activity;
 private final Consumer<String> cancelSpeech;
 private final boolean allowLoopback;
 private AlertDialog dialog;
 private PluginCall pending;
 private BooleanSupplier current;
 private String binding, token, text, requestId;
 private long generation, expires;
 private boolean approved;
 /**
  * @param cancelSpeech stops the host's speech request with the given id when reading is cancelled
  * @param allowLoopback development builds only: a plain-http loopback speech origin is accepted
  */
 public BrowserReviewedReading(android.app.Activity activity,Consumer<String> cancelSpeech,boolean allowLoopback){this.activity=activity;this.cancelSpeech=cancelSpeech;this.allowLoopback=allowLoopback;}
 /** The speech route, owner and session a reading is bound to, or an exception when invalid. */
 String binding(PluginCall call)throws Exception{
  String origin=call.getString("origin"),owner=call.getString("ownerId"),session=call.getString("sessionId");Long expires=call.getLong("expiresAt");
  if("device".equals(call.getString("execution"))){
   if(origin!=null||owner==null||owner.isBlank()||owner.length()>256||session==null||session.isBlank()||session.length()>256||expires==null||expires<=System.currentTimeMillis()||expires>System.currentTimeMillis()+120000)throw new IllegalArgumentException();
   return new JSONObject().put("execution","device").put("owner",owner).put("session",session).put("expires",expires).toString();
  }
  if(origin==null||origin.length()>2048||owner==null||owner.isBlank()||owner.length()>256||session==null||session.isBlank()||session.length()>256||expires==null||expires<=System.currentTimeMillis())throw new IllegalArgumentException();
  java.net.URI uri=new java.net.URI(origin);boolean local=allowLoopback&&"http".equals(uri.getScheme())&&java.util.Set.of("127.0.0.1","10.0.2.2").contains(uri.getHost());
  if(uri.getHost()==null||(!"https".equals(uri.getScheme())&&!local)||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!"".equals(uri.getRawPath()))throw new IllegalArgumentException();
  return new JSONObject().put("origin",origin).put("owner",owner).put("session",session).put("expires",expires).toString();
 }
 void review(PluginCall call,WebView web,BrowserReadingWorld world,BooleanSupplier stillCurrent){
  review(call,web,world,stillCurrent,false);
 }
 void reviewQuestion(PluginCall call,WebView web,BrowserReadingWorld world,BooleanSupplier stillCurrent){review(call,web,world,stillCurrent,true);}
 /**
  * Stable reject codes, so the renderer never parses message text (J05). A missing isolated world
  * may fall back to a pasted excerpt; a sensitive page never may.
  */
 private static final String ISOLATED_MESSAGE="Isolated page reading is unavailable. Update Android System WebView, then reload this page.";
 private void review(PluginCall call,WebView web,BrowserReadingWorld world,BooleanSupplier stillCurrent,boolean question){
  cancel();final long expected=generation;
  // The provider cannot read in isolation: say so before anything else. No speech route, other page or reload can help, and nothing falls back to the page's own world.
  if(world==null||!world.available()){call.reject(BrowserPageReading.UNSUPPORTED_MESSAGE,BrowserPageReading.READING_UNSUPPORTED);return;}
  try{if(!question)binding=binding(call);}catch(Exception error){call.reject("Select an available speech route before reading");return;}
  if(BrowserPageReading.sensitiveUrl(web.getUrl())){call.reject("Reading unavailable on a sensitive or unverified page",BrowserPageReading.SENSITIVE_PAGE);return;}
  if(!world.ready()){call.reject("This page is not ready for private reading. Reload this page, then try again.",BrowserPageReading.READING_NOT_READY);return;}
  current=stillCurrent;pending=call;expires=System.currentTimeMillis()+120000;
  scheduleTimeout(expected,120000);
  world.evaluate(BrowserPageReading.EXTRACT,encoded->{
   if(expected!=generation)return;
   try{
    if(!current.getAsBoolean())throw new IllegalStateException();
    Object decoded=new JSONTokener(encoded).nextValue();if(!(decoded instanceof JSONObject))throw new IllegalStateException();JSONObject result=(JSONObject)decoded;
    if(result.optBoolean("blocked")){PluginCall rejected=pending;pending=null;cancel();rejected.reject("Reading unavailable on a sensitive or ambiguous page",BrowserPageReading.SENSITIVE_PAGE);return;}
    String extracted=result.getString("text");if(extracted.isBlank()||extracted.length()>BrowserPageReading.MAX_EXCERPT)throw new IllegalStateException();text=extracted;token=UUID.randomUUID().toString();
    String source=android.net.Uri.parse(web.getUrl()).getHost();boolean local="device".equals(call.getString("execution"));
    TextView preview=new TextView(activity);preview.setText(question?"Source: "+source+"\n\nContinue releases this public excerpt to the question editor. Review and edit it there; only Send shares your draft with the selected agent.\n\n"+text:"Source: "+source+"\nSpeech: "+(local?"On this device":call.getString("origin"))+"\nOwner: "+call.getString("ownerId")+(local?"\n\nRead on this device uses local speech. The excerpt is not sent to an agent or speech server.\n":"\n\nRead with selected agent sends exactly the following text for speech.\n")+text.length()+" characters"+(result.optBoolean("truncated")?" (truncated; no further text will be sent)":"")+"\n\n"+text);preview.setTextIsSelectable(true);int padding=(int)(20*activity.getResources().getDisplayMetrics().density);preview.setPadding(padding,padding,padding,padding);
    ScrollView scroll=new ScrollView(activity);scroll.addView(preview);
    dialog=new AlertDialog.Builder(activity).setTitle(question?"Ask about this page?":"Read this page aloud?").setView(scroll).setNegativeButton("Cancel",(d,w)->cancel()).setPositiveButton(question?"Review question":local?"Read on this device":"Read with selected agent",(d,w)->{
     if(expected!=generation||!valid()){cancel();return;}if(question){PluginCall accepted=pending;pending=null;JSObject response=new JSObject();response.put("text",text);cancel();accepted.resolve(response);return;}approved=true;PluginCall accepted=pending;pending=null;dialog=null;JSObject response=new JSObject();response.put("readingToken",token);accepted.resolve(response);
    }).setOnCancelListener(d->cancel()).create();dialog.show();
   }catch(Exception error){cancel();}
  },()->{
   // The isolated world could not run the extraction: the same refusal as a world that never started.
   if(expected!=generation)return;PluginCall rejected=pending;pending=null;cancel();if(rejected!=null)rejected.reject(ISOLATED_MESSAGE,BrowserPageReading.ISOLATED_WORLD_UNAVAILABLE);
  });
 }
 private void scheduleTimeout(long expected,long delay){new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(()->{if(expected==generation)cancel();},delay);}
 private boolean valid(){return current!=null&&current.getAsBoolean()&&System.currentTimeMillis()<expires;}
 /** Releases the approved text once to the bound speech request; later calls fail. */
 public String consume(PluginCall call)throws Exception{
  if(!approved||!valid()||!Objects.equals(token,call.getString("readingToken"))||!Objects.equals(binding,binding(call)))throw new IllegalStateException("Reading approval expired");
  requestId=call.getString("requestId");if(requestId==null||requestId.isBlank()||requestId.length()>256)throw new IllegalArgumentException();approved=false;token=null;String result=text;text=null;
  if("device".equals(call.getString("execution"))){expires=System.currentTimeMillis()+20*60*1000;scheduleTimeout(++generation,20*60*1000);}
  dialog=new AlertDialog.Builder(activity).setTitle("device".equals(call.getString("execution"))?"Reading on this device":"Reading with selected agent").setMessage("Preparing or playing the reviewed text. Stop reading cancels this request and playback.").setNegativeButton("Stop reading",(d,w)->cancel()).setOnCancelListener(d->cancel()).create();dialog.show();return result;
 }
 void check(){if(current!=null&&!valid())cancel();}
 void cancel(){generation++;PluginCall rejected=pending;pending=null;AlertDialog old=dialog;dialog=null;String active=requestId;requestId=null;current=null;binding=null;token=null;text=null;approved=false;if(old!=null)old.dismiss();if(rejected!=null)rejected.reject("Reading cancelled or page unavailable");if(active!=null)cancelSpeech.accept(active);}
}
