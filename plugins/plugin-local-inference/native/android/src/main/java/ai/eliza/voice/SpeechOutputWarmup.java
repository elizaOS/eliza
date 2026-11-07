package ai.eliza.voice;

/** Keeps the speech output path out of standby with silence until the reply's first samples are ready. */
public final class SpeechOutputWarmup implements AutoCloseable {
 private static final long LIMIT_NS=15_000_000_000L;
 private volatile boolean closed;
 private final Thread writer;
 public SpeechOutputWarmup(int rate){
  writer=new Thread(()->{
   AudioTrackSpeechOutput output=null;
   try{
    output=AudioTrackSpeechOutput.open(rate);output.play();
    float[] silence=new float[rate/50];long end=System.nanoTime()+LIMIT_NS;
    while(!closed&&System.nanoTime()<end)if(output.write(silence,0,silence.length)<0)break;
   }catch(RuntimeException unavailable){/* Only the warm start is lost. */}
   finally{if(output!=null)try{output.abort();output.release();}catch(RuntimeException ignored){/* Released. */}}
  },"eliza-speech-warmup");
  writer.setDaemon(true);writer.start();
 }
 @Override public void close(){closed=true;}
}
