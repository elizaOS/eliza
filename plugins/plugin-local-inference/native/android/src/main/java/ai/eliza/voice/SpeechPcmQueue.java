package ai.eliza.voice;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

/**
 * Bounded hand-off of synthesized speech PCM from the synthesis worker to the playback writer. Capacity is counted in samples, so a slow speaker applies backpressure to the
 * synthesis callback instead of letting a long passage accumulate in memory. The producer blocks
 * while the queue is full; a cancelled (closed) queue refuses further chunks and zeroes every
 * buffer it still holds. Pure Java: the host JVM fixture checks it.
 */
public final class SpeechPcmQueue {
 /** Upstream ParadeeVoice delivers at most this many mono samples per callback. */
 public static final int CHUNK_LIMIT=24_000;
 /** Returned by {@link #take} once the producer completed and every chunk was taken. */
 public static final float[] END=new float[0];
 private final int capacity;
 private final ArrayDeque<float[]> chunks=new ArrayDeque<>();
 private int queued;
 private boolean complete,closed;

 public SpeechPcmQueue(int capacitySamples){
  if(capacitySamples<CHUNK_LIMIT)throw new IllegalArgumentException("Capacity below one chunk");
  capacity=capacitySamples;
 }

 /**
  * Queues {@code chunk} (ownership passes to the queue), blocking while it would exceed the
  * capacity. Returns false, after zeroing the chunk, when the queue was closed or the wait timed
  * out; the caller then stops synthesis.
  */
 public synchronized boolean offer(float[] chunk,long timeout,TimeUnit unit)throws InterruptedException{
  if(chunk==null||chunk.length==0||chunk.length>CHUNK_LIMIT)throw new IllegalArgumentException("Invalid PCM chunk");
  if(complete)throw new IllegalStateException("Stream already complete");
  long deadline=System.nanoTime()+unit.toNanos(timeout);
  while(!closed&&queued>0&&queued+chunk.length>capacity){
   long left=deadline-System.nanoTime();
   if(left<=0){Arrays.fill(chunk,0f);return false;}
   TimeUnit.NANOSECONDS.timedWait(this,left);
  }
  if(closed){Arrays.fill(chunk,0f);return false;}
  chunks.addLast(chunk);queued+=chunk.length;notifyAll();return true;
 }
 /** The producer delivered its final chunk. */
 public synchronized void complete(){if(!closed){complete=true;notifyAll();}}
 /**
  * The next chunk (ownership passes to the caller, who zeroes it after use), {@link #END} after
  * the last one, or null when nothing arrived within the timeout (an underrun).
  * @throws CancellationException once the queue is closed
  */
 public synchronized float[] take(long timeout,TimeUnit unit)throws InterruptedException{
  long deadline=System.nanoTime()+unit.toNanos(timeout);
  while(!closed&&chunks.isEmpty()&&!complete){
   long left=deadline-System.nanoTime();
   if(left<=0)return null;
   TimeUnit.NANOSECONDS.timedWait(this,left);
  }
  if(closed)throw new CancellationException("Speech stream cancelled");
  if(chunks.isEmpty())return END;
  float[] next=chunks.removeFirst();queued-=next.length;notifyAll();return next;
 }
 /** Cancels the stream: every unplayed buffer is zeroed and dropped; blocked callers return. */
 public synchronized void close(){
  closed=true;
  for(float[] chunk:chunks)Arrays.fill(chunk,0f);
  chunks.clear();queued=0;notifyAll();
 }
 public synchronized boolean closed(){return closed;}
 public synchronized int queuedSamples(){return queued;}
 public int capacity(){return capacity;}
}
