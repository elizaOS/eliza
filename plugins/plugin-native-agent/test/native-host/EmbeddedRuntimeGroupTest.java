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
  /** A child that prints its token (to prove redaction), waits {@code delayMs}, then either exits
   * with status 3 ({@code exit}) or answers its token on loopback. */
  static ProcessBuilder command(EmbeddedRuntimeGroup.Endpoint endpoint, long delayMs, boolean exit) {
    return new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",
      System.getProperty("java.class.path"),EmbeddedRuntimeGroupTest.class.getName(),"child",
      String.valueOf(endpoint.port),endpoint.token,String.valueOf(delayMs),String.valueOf(exit));
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
      System.out.println(args[2]);System.out.flush();
      Thread.sleep(Long.parseLong(args[3]));
      if(Boolean.parseBoolean(args[4]))System.exit(3);
      try(ServerSocket listener=new ServerSocket(Integer.parseInt(args[1]),8,InetAddress.getByName("127.0.0.1"))) {
        for(;;)try(Socket socket=listener.accept()) {
          socket.setSoTimeout(1000);
          String token=new BufferedReader(new InputStreamReader(socket.getInputStream())).readLine();
          socket.getOutputStream().write((args[2].equals(token)?"ready\n":"denied\n").getBytes());
        }
      }
    }
    Path root=Files.createDirectories(Path.of(args[0]));
    // The agent binds late: the gateway must already be up by then, which a serial start cannot do.
    final long agentDelay=1500;
    for(String mode:List.of("success","gateway-failure","cancel-publication","agent-failure","gateway-exit")) {
      Path dir=Files.createDirectory(root.resolve(mode));
      AtomicInteger opens=new AtomicInteger(),closes=new AtomicInteger();
      AtomicReference<NativeRuntimeSession> owner=new AtomicReference<>();
      AtomicReference<EmbeddedRuntimeGroup> groupRef=new AtomicReference<>();
      AtomicReference<String> brokerSecret=new AtomicReference<>();
      AtomicBoolean gatewayUpWhenAgentReady=new AtomicBoolean(),agentReadyAtGatewaySpawn=new AtomicBoolean(true);
      AtomicBoolean gatewayProbedBeforeAgentReady=new AtomicBoolean(),agentReady=new AtomicBoolean();
      List<String> events=Collections.synchronizedList(new ArrayList<>());
      NativeProcessLog log=new NativeProcessLog(dir.resolve("runtime.log"),4096,512);
      EmbeddedRuntimeGroup group=new EmbeddedRuntimeGroup(log,"synthetic-agent-authority",(name,bytes)->{
        RuntimePrivateFiles.write(dir.resolve(name),bytes,path->{});events.add(name);
        if(mode.equals("cancel-publication")&&name.equals("agent-token"))owner.get().invalidate();
      },(endpoint,gateway)->{
        boolean answer=ready(endpoint,gateway);
        if(gateway&&!agentReady.get())gatewayProbedBeforeAgentReady.set(true);
        if(!gateway&&answer&&agentReady.compareAndSet(false,true))
          gatewayUpWhenAgentReady.set(ready(groupRef.get().gateway(),true));
        return answer;
      },6000,6000,10);
      groupRef.set(group);
      long[] started={0},launched={0};
      AtomicBoolean finished=new AtomicBoolean();
      NativeRuntimeSession session=new NativeRuntimeSession(scope->{
        started[0]=System.nanoTime();
        try { group.launch(scope,agent->{
          // Every private file is published before the agent exists.
          check(events.equals(List.of("agent-token","gateway-token","credential-binding.json")));
          events.add("agent");
          // In gateway-exit the agent boots for longer than the gateway lives, so a launch that
          // waited out the agent's boot before noticing the dead gateway would report it ready.
          return command(agent,mode.equals("agent-failure")?200:mode.equals("gateway-exit")?5000:agentDelay,
            mode.equals("agent-failure"));
        },(agent,gateway,brokerPort,brokerToken)->{
          check(events.equals(List.of("agent-token","gateway-token","credential-binding.json","agent","broker")));
          check(brokerPort>0&&brokerToken.length()==64);
          check(group.gateway()==gateway);
          agentReadyAtGatewaySpawn.set(ready(agent,false));
          events.add("gateway");
          if(mode.equals("gateway-failure"))throw new IOException("gateway setup rejected");
          return command(gateway,0,mode.equals("gateway-exit"));
        },token->{
          opens.incrementAndGet();events.add("broker");brokerSecret.set(token);
          ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));
          return new EmbeddedRuntimeGroup.Broker(){public int port(){return socket.getLocalPort();}public void close(){closes.incrementAndGet();try{socket.close();}catch(IOException failure){throw new AssertionError(failure);}}};
        },"product-binding".getBytes(),List.of("synthetic-provider-authority"));
        launched[0]=System.nanoTime(); } finally { finished.set(true); }
      },10,10,0);
      owner.set(session);
      try {
        session.start();
        if(mode.equals("success")) {
          until(()->session.snapshot().lifecycle.state==NativeProcessSupervisor.State.RUNNING);
          check(session.snapshot().processes.size()==2);
          check(Files.readString(dir.resolve("agent-token")).equals(group.agent().token));
          check(Files.readString(dir.resolve("gateway-token")).equals(group.gateway().token));
          check(Files.readString(dir.resolve("credential-binding.json")).equals("product-binding"));
          // The gateway was spawned while the agent was still booting and was up when the agent
          // first answered; its own readiness is still only awaited after the agent's.
          check(!agentReadyAtGatewaySpawn.get());
          check(gatewayUpWhenAgentReady.get());
          check(!gatewayProbedBeforeAgentReady.get());
          System.out.println("EmbeddedRuntimeGroup: launch to RUNNING "
            +TimeUnit.NANOSECONDS.toMillis(launched[0]-started[0])+" ms with a "+agentDelay+" ms agent boot");
        } else if(mode.equals("gateway-failure")) {
          until(()->session.snapshot().lifecycle.state==NativeProcessSupervisor.State.FAILED);
          until(()->closes.get()==1);
          // The already-started agent is ended with the failed launch.
          until(()->session.snapshot().processes.values().stream().noneMatch(Process::isAlive));
        } else if(mode.equals("cancel-publication")) {
          until(()->events.contains("agent-token"));
          until(finished::get);
          // Cancelled during publication: no child was spawned and no broker opened.
          check(session.snapshot().processes.isEmpty());
          check(opens.get()==0);check(!Files.exists(dir.resolve("credential-binding.json")));
        } else {
          // A child that exits before readiness fails the launch, ends the other child and
          // closes the broker; the launch never reaches RUNNING.
          until(()->session.snapshot().lifecycle.state==NativeProcessSupervisor.State.FAILED);
          until(()->closes.get()==1);
          until(()->session.snapshot().processes.values().stream().noneMatch(Process::isAlive));
          check(launched[0]==0);
          // A gateway that exits while the agent boots fails the agent's wait at once.
          if(mode.equals("gateway-exit"))check(!agentReady.get());
        }
      } finally { session.close(); }
      until(()->session.snapshot().processes.values().stream().noneMatch(Process::isAlive));
      check(opens.get()==closes.get());
      // A launch cancelled before any child spawned never opens the log.
      String output=Files.exists(dir.resolve("runtime.log"))?Files.readString(dir.resolve("runtime.log")):"";
      // Both children printed their token; each line reached the log redacted.
      if(mode.equals("success"))check(output.lines().count()>=2);
      check(!output.contains("synthetic-agent-authority"));
      if(group.gateway()!=null)check(!output.contains(group.gateway().token));
      if(brokerSecret.get()!=null)check(!output.contains(brokerSecret.get()));
    }
    System.out.println("EmbeddedRuntimeGroup: "+checks+" checks passed");
  }
}
