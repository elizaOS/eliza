package ai.eliza.voice;
import java.util.concurrent.CountDownLatch;
/**
 * Test double of the shared session: a call loads the models when no client holds them, a
 * client's release drops its hold, and the models are freed once no client holds them. A call
 * can be held open with {@link #gate} to stand for work in flight.
 */
public final class InferenceSession {
 public volatile int loads,frees,releases,releasedWhileRunning,cancels;
 /** When set, the next call waits here before it returns. */
 public volatile CountDownLatch gate;
 /** Counts down when a call starts. */
 public volatile CountDownLatch started;
 private int holders;
 private volatile boolean loaded;
 private volatile int running;
 public boolean isClosed(){return false;}
 public Client client(){return new Client();}
 public java.util.List<String> speechLanguages(){return java.util.List.of("en");}
 public final class TextStream implements AutoCloseable {public String next(){throw new UnsupportedOperationException();} public void close(){}}
 public final class Client {
  private boolean holding;
  private void call()throws java.io.IOException{
   synchronized(InferenceSession.this){
    if(!holding){holding=true;holders++;}
    if(!loaded){loaded=true;loads++;}
    running++;
   }
   try{
    CountDownLatch go=gate,begun=started;
    if(begun!=null)begun.countDown();
    if(go!=null)go.await();
   }catch(InterruptedException stop){throw new java.io.InterruptedIOException();}
   finally{synchronized(InferenceSession.this){running--;}}
  }
  public java.util.List<String> speechLanguages(){return InferenceSession.this.speechLanguages();}
  public void prepareVoice(String language)throws java.io.IOException{call();}
  public void prepareRecognition()throws java.io.IOException{call();}
  public ParadeeVoice.Audio synthesize(String text,float speed,String language)throws java.io.IOException{call();return new ParadeeVoice.Audio(new float[240],24000);}
  public String transcribe(float[] pcm)throws java.io.IOException{call();return "heard";}
  public TextStream openTextStream(String prompt,int maxTokens){throw new UnsupportedOperationException();}
  public float[] embed(String text,int pooling){throw new UnsupportedOperationException();}
  public void cancel(){cancels++;}
  public void release(){
   synchronized(InferenceSession.this){
    releases++;
    if(running>0)releasedWhileRunning++;
    if(holding){holding=false;holders--;}
    if(holders==0&&loaded){loaded=false;frees++;}
   }
  }
 }
}
