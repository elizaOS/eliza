package ai.eliza.voice;

import java.util.function.LongSupplier;

/**
 * Keeps the speech output path out of standby with silence until the reply's first samples are
 * ready. Bounded by {@link #LIMIT_NS}; {@link #close} is idempotent, aborts a blocked write and
 * fences a late open, so a closed warm-up never starts or keeps playing.
 */
public final class SpeechOutputWarmup implements AutoCloseable {
 public static final long LIMIT_NS=15_000_000_000L;
 private volatile boolean closed;
 private final Object lifecycle=new Object();
 private StreamingSpeechPlayback.Output output; // Guarded by lifecycle.
 private final Thread writer;

 public SpeechOutputWarmup(int rate){this(rate,()->AudioTrackSpeechOutput.open(rate),System::nanoTime);}
 SpeechOutputWarmup(int rate,StreamingSpeechPlayback.OutputFactory factory,LongSupplier now){
  writer=new Thread(()->{
   StreamingSpeechPlayback.Output opened=null;
   try{
    opened=factory.open();
    synchronized(lifecycle){
     if(closed)return;
     output=opened;
     opened.play();
    }
    float[] silence=new float[rate/50];long end=now.getAsLong()+LIMIT_NS;
    while(!closed&&now.getAsLong()<end)if(opened.write(silence,0,silence.length)<=0)break;
   }catch(Exception unavailable){/* Only the warm start is lost. */}
   finally{
    synchronized(lifecycle){if(output==opened)output=null;}
    if(opened!=null){try{opened.abort();}catch(RuntimeException ignored){/* Released below. */}try{opened.release();}catch(RuntimeException ignored){/* Released. */}}
   }
  },"eliza-speech-warmup");
  writer.setDaemon(true);writer.start();
 }
 @Override public void close(){
  StreamingSpeechPlayback.Output active;
  synchronized(lifecycle){
   closed=true;
   active=output;
  }
  if(active!=null)try{active.abort();}catch(RuntimeException ignored){/* The writer releases it. */}
  writer.interrupt();
 }
}
