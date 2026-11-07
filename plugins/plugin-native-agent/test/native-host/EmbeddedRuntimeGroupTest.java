package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.*;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

public final class EmbeddedRuntimeGroupTest {
  static int checks;
  static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
  static void until(BooleanSupplier condition) throws Exception {
    long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
    while(!condition.getAsBoolean()&&System.nanoTime()<deadline)Thread.sleep(10);
    check(condition.getAsBoolean());
  }
  static ProcessBuilder command(EmbeddedRuntimeGroup.Endpoint endpoint) {
    return new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",
      System.getProperty("java.class.path"),EmbeddedRuntimeGroupTest.class.getName(),"child",String.valueOf(endpoint.port),endpoint.token);
  }
  static boolean ready(EmbeddedRuntimeGroup.Endpoint endpoint, boolean gateway) throws Exception {
    try(Socket socket=new Socket()) {
      socket.connect(new InetSocketAddress("127.0.0.1",endpoint.port),100);socket.setSoTimeout(100);
      socket.getOutputStream().write((endpoint.token+"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
      return "ready".equals(new BufferedReader(new InputStreamReader(socket.getInputStream())).readLine());
    } catch(IOException unavailable) { return false; }
  }
  public static void main(String[] args) throws Exception {
    if(args.length>0&&args[0].equals("child")) {
      try(ServerSocket listener=new ServerSocket(Integer.parseInt(args[1]),8,InetAddress.getByName("127.0.0.1"))) {
        System.out.println(args[2]);System.out.flush();
        for(;;)try(Socket socket=listener.accept()) {
          socket.setSoTimeout(1000);
          String token=new BufferedReader(new InputStreamReader(socket.getInputStream())).readLine();
          socket.getOutputStream().write((args[2].equals(token)?"ready\n":"denied\n").getBytes());
        }
      }
    }
    Path root=Files.createDirectories(Path.of(args[0]));
    for(String mode:List.of("success","gateway-failure","cancel-publication")) {
      Path dir=Files.createDirectory(root.resolve(mode));
      AtomicInteger opens=new AtomicInteger(),closes=new AtomicInteger();
      AtomicReference<NativeRuntimeSession> owner=new AtomicReference<>();
      List<String> published=Collections.synchronizedList(new ArrayList<>());
      NativeProcessLog log=new NativeProcessLog(dir.resolve("runtime.log"),4096,512);
      EmbeddedRuntimeGroup group=new EmbeddedRuntimeGroup(log,"synthetic-agent-authority",(name,bytes)->{
        RuntimePrivateFiles.write(dir.resolve(name),bytes,path->{});published.add(name);
        if(mode.equals("cancel-publication")&&name.equals("agent-token"))owner.get().invalidate();
      },EmbeddedRuntimeGroupTest::ready,3000,3000,10);
      NativeRuntimeSession session=new NativeRuntimeSession(scope->group.launch(scope,EmbeddedRuntimeGroupTest::command,
        (agent,gateway,brokerPort,brokerToken)->{
          check(published.equals(List.of("agent-token","gateway-token","credential-binding.json")));
          check(brokerPort>0&&brokerToken.length()==64);
          if(mode.equals("gateway-failure"))throw new IOException("gateway setup rejected");
          return command(gateway);
        },token->{
          opens.incrementAndGet();ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));
          return new EmbeddedRuntimeGroup.Broker(){public int port(){return socket.getLocalPort();}public void close(){closes.incrementAndGet();try{socket.close();}catch(IOException failure){throw new AssertionError(failure);}}};
        },"product-binding".getBytes(),List.of("synthetic-provider-authority")),10,10,0);
      owner.set(session);
      try {
        session.start();
        if(mode.equals("success")) {
          until(()->session.snapshot().lifecycle.state==NativeProcessSupervisor.State.RUNNING);
          check(session.snapshot().processes.size()==2);
          check(Files.readString(dir.resolve("agent-token")).equals(group.agent().token));
          check(Files.readString(dir.resolve("gateway-token")).equals(group.gateway().token));
          check(Files.readString(dir.resolve("credential-binding.json")).equals("product-binding"));
        } else if(mode.equals("gateway-failure")) {
          until(()->session.snapshot().lifecycle.state==NativeProcessSupervisor.State.FAILED);
          until(()->closes.get()==1);
        } else {
          until(()->published.contains("agent-token"));
          until(()->session.snapshot().processes.values().stream().noneMatch(Process::isAlive));
          check(opens.get()==0);check(!Files.exists(dir.resolve("credential-binding.json")));
        }
      } finally { session.close(); }
      until(()->session.snapshot().processes.values().stream().noneMatch(Process::isAlive));
      check(opens.get()==closes.get());
      check(!Files.readString(dir.resolve("runtime.log")).contains("synthetic-agent-authority"));
    }
    System.out.println("EmbeddedRuntimeGroup: "+checks+" checks passed");
  }
}
