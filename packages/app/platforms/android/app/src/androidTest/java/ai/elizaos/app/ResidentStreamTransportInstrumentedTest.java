package ai.elizaos.app;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Process;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.Test;
import org.junit.Assume;
import static org.junit.Assert.*;

/** Controlled Android socket transport only: never launches an agent or contacts a provider. */
public final class ResidentStreamTransportInstrumentedTest {
 private static void await(CountDownLatch latch,String label)throws Exception {assertTrue(label,latch.await(5,TimeUnit.SECONDS));}
 private static String request(String id)throws Exception {return new JSONObject().put("path","/api/stream-fixture").put("method","POST").put("timeoutMs",10000).put("headers",new JSONObject().put("Authorization","Bearer synthetic-native-transport-fixture")).put("body",new JSONObject().put("fixtureId",id).toString()).toString();}
 private static void send(LocalSocket socket,String value)throws Exception {
  byte[] bytes=(value+"\n").getBytes(StandardCharsets.UTF_8);
  // Split within JSON syntax and encoded content; framing must survive arbitrary reads.
  for(int offset=0;offset<bytes.length;){int length=Math.min(3,bytes.length-offset);socket.getOutputStream().write(bytes,offset,length);socket.getOutputStream().flush();offset+=length;}
 }
 private static String readLine(LocalSocket socket)throws Exception {
  ByteArrayOutputStream out=new ByteArrayOutputStream();int b;
  while((b=socket.getInputStream().read())!=-1&&b!='\n'){assertTrue("bounded fixture request",out.size()<16384);out.write(b);}
  assertTrue("request frame terminated",b=='\n');return out.toString("UTF-8");
 }
 private static void quiet(Closeable value){try{if(value!=null)value.close();}catch(IOException ignored){}}
 private static final class Client {
  final ElizaAgentService.LocalStreamHandle handle=new ElizaAgentService.LocalStreamHandle();
  final List<JSONObject> events=Collections.synchronizedList(new ArrayList<>());
  final CountDownLatch chunk=new CountDownLatch(1),done=new CountDownLatch(1);
  final AtomicReference<Throwable> failure=new AtomicReference<>();
  final Thread thread;
  Client(String id)throws Exception {
   String input=request(id);
   thread=new Thread(()->{try{ElizaAgentService.requestLocalAgentStream(input,event->{try{JSONObject value=new JSONObject(event);events.add(value);if("chunk".equals(value.optString("type")))chunk.countDown();}catch(Exception error){failure.set(error);}},handle);}catch(Throwable error){failure.set(error);}finally{done.countDown();}},"resident-stream-fixture-client");thread.start();
  }
  void finished(boolean error)throws Exception {
   await(done,"native transport returns");assertNull(failure.get());
   int terminals=0; synchronized(events){for(JSONObject event:events)if("complete".equals(event.optString("type"))){terminals++;assertEquals("terminal error contract",error,event.has("error")&&!event.optString("error").isEmpty());}}
   assertEquals("one terminal event",1,terminals);
  }
  void close()throws Exception {handle.cancel();thread.join(5000);assertFalse("client thread stopped; state="+thread.getState()+" stack="+Arrays.toString(thread.getStackTrace()),thread.isAlive());}
 }
 private static final class Peer implements AutoCloseable {
  final LocalServerSocket server;
  final List<LocalSocket> sockets=Collections.synchronizedList(new ArrayList<>());
  final AtomicInteger accepted=new AtomicInteger(),posts=new AtomicInteger();
  final AtomicReference<Throwable> failure=new AtomicReference<>();
  final CountDownLatch received=new CountDownLatch(1),released=new CountDownLatch(1),peerEof=new CountDownLatch(1),drained=new CountDownLatch(1);
  volatile boolean closed,clientReturned;
  final Thread thread;
  Peer(String id,String mode)throws Exception {
   server=new LocalServerSocket(ElizaAgentService.LOCAL_AGENT_SOCKET_NAME);
   thread=new Thread(()->{try{while(!closed){android.system.StructPollfd poll=new android.system.StructPollfd();poll.fd=server.getFileDescriptor();poll.events=(short)android.system.OsConstants.POLLIN;if(android.system.Os.poll(new android.system.StructPollfd[]{poll},100)==0){if(clientReturned)drained.countDown();continue;}if(closed)break;LocalSocket socket=server.accept();sockets.add(socket);accepted.incrementAndGet();socket.setSoTimeout(5000);
    assertEquals("only same UID peer",Process.myUid(),socket.getPeerCredentials().getUid());
    JSONObject frame=new JSONObject(readLine(socket));assertEquals("http_request_stream",frame.getString("method"));assertTrue(frame.getBoolean("stream"));JSONObject payload=frame.getJSONObject("payload");assertEquals("POST",payload.getString("method"));assertEquals(id,new JSONObject(payload.getString("body")).getString("fixtureId"));posts.incrementAndGet();received.countDown();
    send(socket,"{\"stream\":\"response\",\"status\":200,\"statusText\":\"OK\",\"headers\":{}}");
    send(socket,"{\"stream\":\"chunk\",\"dataBase64\":\"aGVsbG8=\"}");
    if("complete".equals(mode)){send(socket,"{\"stream\":\"complete\"}");quiet(socket);}
    else if("error".equals(mode)){send(socket,"{\"stream\":\"complete\",\"error\":\"controlled peer error\"}");quiet(socket);}
    else if("eof".equals(mode)){quiet(socket);}
    else {assertEquals("cancel",mode);await(released,"test permits peer EOF observation");assertEquals("cancellation closes actual socket",-1,socket.getInputStream().read());peerEof.countDown();quiet(socket);}
   }}catch(Throwable error){if(!closed)failure.set(error);}},"resident-stream-fixture-peer");thread.start();
  }
  public void close()throws Exception {closed=true;released.countDown();synchronized(sockets){for(LocalSocket socket:sockets)quiet(socket);}thread.join(5000);server.close();assertFalse("peer thread stopped",thread.isAlive());if(failure.get()!=null)throw new AssertionError("controlled peer failed",failure.get());}
 }
 private void scenario(String mode)throws Exception {
  System.out.println("RESIDENT_STREAM_SCENARIO_BEGIN "+mode);
  String id=UUID.randomUUID().toString();Client client=null;Throwable primary=null;
  try(Peer peer=new Peer(id,mode)) {
   try {client=new Client(id);await(peer.received,"exact POST observed");await(client.chunk,"native chunk witnessed before terminal/cancel");
    if("cancel".equals(mode)){client.handle.cancel();peer.released.countDown();await(peer.peerEof,"peer sees cancelled connection EOF");}
    client.finished(!"complete".equals(mode));
    assertEquals("response first","response",client.events.get(0).getString("type"));assertEquals("chunk second","chunk",client.events.get(1).getString("type"));assertEquals("split frame content","aGVsbG8=",client.events.get(1).getString("dataBase64"));assertEquals(3,client.events.size());
    // Client method has returned; all its retry/control paths are finished. Keep peer bound through that point.
    peer.clientReturned=true;await(peer.drained,"listener backlog drained after client return");assertEquals("exactly one connection; no replay",1,peer.accepted.get());assertEquals("exactly one POST; no replay",1,peer.posts.get());
   }catch(Throwable error){primary=error;throw error;}finally{if(client!=null)try{client.close();}catch(Throwable cleanup){if(primary!=null)primary.addSuppressed(cleanup);else throw cleanup;}}
   System.out.println("RESIDENT_STREAM_SCENARIO_PASS "+mode);
  }
 }
 @Test public void splitFramesCancellationAndNoReplay()throws Exception {
  Assume.assumeTrue("Explicit resident stream fixture required","1".equals(InstrumentationRegistry.getArguments().getString("residentStreamFixture")));assertTrue(BuildConfig.DEBUG);assertTrue("disposable user only",Process.myUid()/100000>0);
  assertTrue("explicit supervisor admission required",InstrumentationRegistry.getArguments().getString("residentStreamRunId","").matches("[0-9a-f-]{36}"));
  JSONObject status=ElizaAgentService.getLocalAgentBootState(InstrumentationRegistry.getInstrumentation().getTargetContext());assertFalse(status.getBoolean("serviceActive"));assertFalse(status.getBoolean("socketListening"));

  scenario("complete");
  scenario("cancel");
  scenario("eof");
  scenario("error");
  // No listener: observe the production retry delay on the actual client thread, then cancel.
  Client client=new Client(UUID.randomUUID().toString());
  try {boolean witnessed=false;long deadline=SystemClock.elapsedRealtime()+3000;
   while(SystemClock.elapsedRealtime()<deadline&&!witnessed){for(StackTraceElement frame:client.thread.getStackTrace())if(frame.getClassName().equals(ElizaAgentService.class.getName())&&frame.getMethodName().equals("connectLocalAgentSocket")&&client.thread.getState()==Thread.State.TIMED_WAITING)witnessed=true;if(!witnessed)SystemClock.sleep(10);}
   assertTrue("actual connect retry sleep witnessed",witnessed);long cancelled=SystemClock.elapsedRealtime();client.handle.cancel();client.finished(true);assertTrue("cancellation bounded below full retry deadline",SystemClock.elapsedRealtime()-cancelled<2000);assertEquals("no response/chunk while unconnected",1,client.events.size());
  }finally{client.close();}
 }
}
