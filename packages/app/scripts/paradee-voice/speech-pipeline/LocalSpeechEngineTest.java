package ai.eliza.voice;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
final class LocalSpeechEngineTest{
 static void check(boolean okay,String message){if(!okay)throw new AssertionError(message);}
 static final class Engine implements LocalSpeechEngine.Backend{
  final CountDownLatch entered=new CountDownLatch(1),cancelled=new CountDownLatch(1);int closes;
  public String transcribe(float[] samples)throws Exception{entered.countDown();if(!cancelled.await(2,TimeUnit.SECONDS))throw new AssertionError("Cancellation waited behind native call");throw new CancellationException();}
  public LocalSpeechEngine.Audio synthesize(String text,java.util.function.BooleanSupplier cancel){return new LocalSpeechEngine.Audio(new float[]{0.1f,0.2f},16000);}
  public void cancel(){cancelled.countDown();}public void close(){closes++;}
 }
 public static void main(String[]args)throws Exception{
  AtomicInteger created=new AtomicInteger();AtomicReference<Engine> active=new AtomicReference<>();LocalSpeechEngine holder=new LocalSpeechEngine(()->{created.incrementAndGet();Engine e=new Engine();active.set(e);return e;});
  holder.use(e->null);holder.use(e->null);check(created.get()==1,"models reused");
  ExecutorService worker=Executors.newSingleThreadExecutor();try{Future<String> running=worker.submit(()->holder.use(e->e.transcribe(new float[1600])));check(active.get().entered.await(2,TimeUnit.SECONDS),"entered native");holder.cancel();try{running.get(2,TimeUnit.SECONDS);throw new AssertionError();}catch(ExecutionException expected){check(expected.getCause() instanceof CancellationException,"native cancellation surfaced");}}finally{worker.shutdownNow();}
  Engine old=active.get();holder.release();check(old.closes==1,"released once");holder.use(e->null);check(created.get()==2,"reopens after release");holder.close();holder.close();check(active.get().closes==1,"close idempotent");try{holder.use(e->null);throw new AssertionError();}catch(IllegalStateException expected){}
  AtomicBoolean speechLoaded=new AtomicBoolean();
  LocalSpeechEngine lazy=new LocalSpeechEngine(()->new LocalSpeechEngine.Backend(){
   public boolean speechLoaded(){return speechLoaded.get();}
   public String transcribe(float[] samples){return "heard";}
   public LocalSpeechEngine.Audio synthesize(String text,java.util.function.BooleanSupplier cancelled){speechLoaded.set(true);return new LocalSpeechEngine.Audio(new float[]{0.1f},24000);}
   public void cancel(){}public void close(){speechLoaded.set(false);}
  });
  lazy.use(e->e.supportsStreaming());lazy.use(e->e.transcribe(new float[1600]));check(lazy.loads()==0,"capability and ASR probes leave speech cold");
  lazy.use(e->e.synthesize("hello",()->false));check(lazy.loads()==1,"first speech advances cold generation");
  lazy.release();lazy.use(e->e.supportsStreaming());check(lazy.loads()==1,"new lazy session is not a speech load");
  lazy.use(e->e.synthesize("again",()->false));check(lazy.loads()==2,"speech after release is cold");lazy.close();
  float[] original={-1f,0f,0.5f,1f};byte[] wav=new LocalSpeechEngine.Audio(original,16000).wav();float[] decoded=LocalSpeechEngine.readMono16kWav(wav);check(decoded.length==4&&Math.abs(decoded[2]-0.5)<0.0001,"PCM round trip");
  wav[40]++;try{LocalSpeechEngine.readMono16kWav(wav);throw new AssertionError();}catch(java.io.IOException expected){}
  try{new LocalSpeechEngine.Audio(new float[]{Float.NaN},16000).wav();throw new AssertionError();}catch(IllegalStateException expected){}
  System.out.println("PASS local speech lifecycle and PCM");
 }
}
