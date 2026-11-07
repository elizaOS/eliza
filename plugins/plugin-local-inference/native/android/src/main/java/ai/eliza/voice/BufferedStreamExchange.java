package ai.eliza.voice;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.json.*;

/**
 * One bounded, buffered request over a cancellable local agent stream (no retries). The stream
 * emits JSON events {@code response} (status), {@code chunk} (base64 body bytes) and
 * {@code complete}; the body is capped at 128 KiB and each event at 256 KiB. One request may be in
 * flight per {@code active} slot. The deadline cancels the stream handle, and {@link Guard#check}
 * runs before dispatch and on every event, so a changed owner or enrollment stops the exchange
 * without dispatching or retrying. Used with {@link LiveSegmentPipe} as its transport.
 */
public final class BufferedStreamExchange {
 private BufferedStreamExchange(){}
 public interface Handle {void cancel();}
 public interface Port {Handle open();void request(JSONObject input,Consumer<String> events,Handle handle)throws Exception;}
 public interface Guard {void check()throws Exception;}
 private static final ScheduledThreadPoolExecutor DEADLINES=new ScheduledThreadPoolExecutor(1,r->{Thread t=new Thread(r,"eliza-voice-stream-deadline");t.setDaemon(true);return t;});
 static {DEADLINES.setRemoveOnCancelPolicy(true);}
 public static JSONObject exchange(Port port,JSONObject input,AtomicReference<Handle> active,Guard guard,long timeoutMs)throws Exception{
  guard.check();Handle handle=port.open();if(!active.compareAndSet(null,handle)){handle.cancel();throw new IllegalStateException("Concurrent voice IPC");}
  ByteArrayOutputStream body=new ByteArrayOutputStream();int[] status={0};boolean[] complete={false};AtomicReference<Exception> failed=new AtomicReference<>();
  ScheduledFuture<?> deadline;
  try{deadline=DEADLINES.schedule(()->{failed.compareAndSet(null,new java.io.IOException("Voice IPC deadline"));handle.cancel();},timeoutMs,TimeUnit.MILLISECONDS);}
  catch(RejectedExecutionException stopped){active.compareAndSet(handle,null);handle.cancel();throw stopped;}
  try{
   guard.check();if(failed.get()!=null)throw failed.get();port.request(input,raw->{try{
    guard.check();if(raw.length()>256*1024)throw new IllegalStateException("Voice response too large");JSONObject event=new JSONObject(raw);
    switch(event.optString("type")){
     case "response":status[0]=event.getInt("status");break;
     case "chunk":byte[] bytes=Base64.getDecoder().decode(event.getString("dataBase64"));if(body.size()+bytes.length>128*1024)throw new IllegalStateException("Voice response too large");body.write(bytes,0,bytes.length);break;
     case "complete":if(event.has("error"))throw new IllegalStateException("Voice transport interrupted");complete[0]=true;break;
     default:throw new IllegalStateException("Unexpected voice response");
    }
   }catch(Exception error){failed.compareAndSet(null,error);handle.cancel();}},handle);
   guard.check();if(failed.get()!=null)throw failed.get();if(!complete[0]||status[0]==0)throw new IllegalStateException("Voice response incomplete");
   return new JSONObject().put("status",status[0]).put("body",new String(body.toByteArray(),StandardCharsets.UTF_8));
  }finally{deadline.cancel(false);active.compareAndSet(handle,null);handle.cancel();body.reset();}
 }
}
