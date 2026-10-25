package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.Objects;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

/** One deadline owns one request socket, including blocked writes and trickled
 * reads. The scheduled timer closes I/O; the monotonic check also rejects a late
 * response if timer dispatch was delayed. Android supplies elapsedRealtimeNanos
 * so a response received after device suspend cannot become fresh evidence. */
public class RuntimeRequestDeadline implements AutoCloseable {
 private static final ScheduledThreadPoolExecutor TIMERS=new ScheduledThreadPoolExecutor(1,r->{Thread t=new Thread(r,"RuntimeRequestDeadline");t.setDaemon(true);return t;});
 static { TIMERS.setRemoveOnCancelPolicy(true); }
 private final Socket socket;private final LongSupplier clock;private final long started,budget;
 private final AtomicBoolean expired=new AtomicBoolean();private final ScheduledFuture<?> timer;
 public RuntimeRequestDeadline(Socket socket,int timeoutMillis,LongSupplier clock){
  if(timeoutMillis<1||timeoutMillis>120000)throw new IllegalArgumentException("Invalid runtime request deadline");
  this.socket=Objects.requireNonNull(socket);this.clock=Objects.requireNonNull(clock);started=clock.getAsLong();budget=TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
  timer=TIMERS.schedule(this::expire,timeoutMillis,TimeUnit.MILLISECONDS);
 }
 private void expire(){expired.set(true);try{socket.close();}catch(IOException ignored){}}
 public void check()throws SocketTimeoutException {
  long elapsed=clock.getAsLong()-started;
  if(expired.get()||elapsed<0||elapsed>=budget){expire();throw new SocketTimeoutException("Local runtime request deadline exceeded");}
 }
 public boolean expired(){return expired.get();}
 @Override public void close(){timer.cancel(false);}
}
