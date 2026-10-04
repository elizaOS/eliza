package ai.eliza.plugins.agent.runtime.test;
import ai.eliza.plugins.agent.runtime.RuntimeRequestDeadline;
import java.io.*;import java.net.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
public final class RuntimeRequestDeadlineTest {
 static int assertions;static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
 public static void main(String[] args)throws Exception {
  // Continuous bytes defeat per-read inactivity timeouts; the whole request ends.
  try(ServerSocket server=new ServerSocket(0,1,InetAddress.getLoopbackAddress());Socket client=new Socket(InetAddress.getLoopbackAddress(),server.getLocalPort());Socket peer=server.accept()){
   ExecutorService worker=Executors.newSingleThreadExecutor();Future<?> writer=worker.submit(()->{try{while(true){peer.getOutputStream().write(1);peer.getOutputStream().flush();Thread.sleep(10);}}catch(Exception expected){}});
   try(RuntimeRequestDeadline deadline=new RuntimeRequestDeadline(client,300,System::nanoTime)){
    client.setSoTimeout(5000);long started=System.nanoTime();int count=0;try{while(client.getInputStream().read()!=-1)count++;throw new AssertionError("Trickle unexpectedly ended normally");}catch(IOException expected){check(deadline.expired());check(count>0);check(System.nanoTime()-started<TimeUnit.SECONDS.toNanos(5));}
   }finally{peer.close();writer.cancel(true);worker.shutdownNow();}
  }
  // A peer that accepts but never reads cannot block an outbound request forever.
  try(ServerSocket server=new ServerSocket(0,1,InetAddress.getLoopbackAddress());Socket client=new Socket()){
   client.setSendBufferSize(1024);client.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(),server.getLocalPort()));try(Socket peer=server.accept();RuntimeRequestDeadline deadline=new RuntimeRequestDeadline(client,300,System::nanoTime)){
    peer.setReceiveBufferSize(1024);long started=System.nanoTime();try{byte[] bytes=new byte[65536];for(int i=0;i<1024;i++)client.getOutputStream().write(bytes);throw new AssertionError("Unconsumed write unexpectedly completed");}catch(IOException expected){check(deadline.expired());check(System.nanoTime()-started<TimeUnit.SECONDS.toNanos(5));}
   }
  }
  // Cancelling a completed request removes its timer; it cannot close a later use.
  try(Socket socket=new Socket()){
   try(RuntimeRequestDeadline deadline=new RuntimeRequestDeadline(socket,100,System::nanoTime)){deadline.check();}
   Thread.sleep(250);check(!socket.isClosed());
  }
  // Delayed dispatch, suspend/elapsed advancement and clock regression fail closed.
  for(long later:new long[]{TimeUnit.SECONDS.toNanos(3),-1})try(Socket socket=new Socket()){
   AtomicLong clock=new AtomicLong();try(RuntimeRequestDeadline deadline=new RuntimeRequestDeadline(socket,1000,clock::get)){clock.set(later);try{deadline.check();throw new AssertionError("Late response accepted");}catch(SocketTimeoutException expected){check(socket.isClosed());check(deadline.expired());}}
  }
  for(int invalid:new int[]{0,-1,120001})try(Socket socket=new Socket()){try{new RuntimeRequestDeadline(socket,invalid,System::nanoTime);throw new AssertionError("Invalid timeout accepted");}catch(IllegalArgumentException expected){check(!socket.isClosed());}}
  System.out.println("RuntimeRequestDeadline: "+assertions+" assertions passed");
 }
}
