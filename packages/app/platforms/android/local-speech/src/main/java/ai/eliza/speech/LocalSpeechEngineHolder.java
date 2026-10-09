package ai.eliza.speech;

/** MIT. Serialized reusable model weights, with explicit ownership and release.
 * Call use/release/close on a worker, never on the Android main thread. No audio,
 * transcript, conversation, credential, or account identity is stored here. */
public final class LocalSpeechEngineHolder implements AutoCloseable {
 @FunctionalInterface public interface Factory { LocalSpeechEngine create() throws Exception; }
 @FunctionalInterface public interface Operation<T> { T run(LocalSpeechEngine engine) throws Exception; }
 private final Factory factory;
 private LocalSpeechEngine engine;
 private boolean closed;
 public LocalSpeechEngineHolder(Factory factory){this.factory=factory;}
 public synchronized <T> T use(Operation<T> operation)throws Exception {
  if(closed)throw new IllegalStateException("Speech holder closed");
  if(engine==null)engine=factory.create();
  return operation.run(engine);
 }
 public synchronized void release(){LocalSpeechEngine previous=engine;engine=null;if(previous!=null)previous.close();}
 @Override public synchronized void close(){if(closed)return;closed=true;release();}
}
