package ai.elizaos.app;

import com.getcapacitor.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Real plugin dispatch and service parser over HTTP; OS launch/stop are held host ports. */
public final class NativeOwnerDispatchTest {
  static final List<String> failures = new ArrayList<>();
  static int checks, requests, pairs;
  static volatile CountDownLatch held, release;
  static String lastBearer, lastBody, lastMethod, lastIdempotency, lastClient;
  static void check(boolean value, String reason) { checks++; if (!value) { failures.add(reason); System.err.println("FAIL: "+reason); } }
  static PluginCall call(String path, String method, String body) {
    JSObject value = new JSObject().put("path", path).put("method", method);
    if (body != null) value.put("body", body);
    return new PluginCall(value);
  }
  static PluginCall read(AgentPlugin plugin) { PluginCall c=call("/api/config","GET",null);plugin.request(c);return c; }
  static void denied(PluginCall c, String reason) { check(c.error != null && c.result == null, reason); }
  static void ok(PluginCall c, String reason) { check(c.error == null && c.result != null, reason); }
  static void await(CountDownLatch latch) { try { if(!latch.await(5,TimeUnit.SECONDS))throw new AssertionError("Timed out"); } catch(InterruptedException e){throw new AssertionError(e);} }
  static Thread thread(Runnable run) { Thread value=new Thread(run);value.start();return value; }
  static void join(Thread value) throws Exception {value.join(5000);check(!value.isAlive(),"worker finished");}

  public static void main(String[] args) throws Exception {
    HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    ExecutorService workers=Executors.newCachedThreadPool();server.setExecutor(workers);
    server.createContext("/", exchange->{
      try {
        synchronized(NativeOwnerDispatchTest.class){requests++;}
        String path=exchange.getRequestURI().getPath();
        String bearer=exchange.getRequestHeaders().getFirst("Authorization");
        String body=new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8);
        JSONObject result;
        if(path.equals("/api/auth/status")) result=new JSONObject().put("authenticated",true).put("instanceId","instance");
        else if(path.equals("/api/auth/pair-code")) result=new JSONObject().put("code","code");
        else if(path.equals("/api/auth/pair")){pairs++;result=new JSONObject().put("token","owner-token").put("identityId","owner").put("instanceId","instance").put("access","owner");}
        else if(path.equals("/api/auth/me")) result=new JSONObject().put("access",new JSONObject().put("role","OWNER")).put("identity",new JSONObject().put("id","owner")).put("session",new JSONObject().put("id","owner-token").put("expiresAt",System.currentTimeMillis()+600000));
        else {
          lastBearer=bearer;lastBody=body;lastMethod=exchange.getRequestMethod();
          lastIdempotency=exchange.getRequestHeaders().getFirst("Idempotency-Key");
          lastClient=exchange.getRequestHeaders().getFirst("X-ElizaOS-Client-Id");
          CountDownLatch wait=held,done=release;if(wait!=null){held=null;wait.countDown();await(done);}
          result=new JSONObject().put("data","runtime");
        }
        byte[] bytes=result.toString().getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);
      } finally {exchange.close();}
    });server.start();
    ElizaAgentService.exchange=payload->{
      try {
        URL url=new URL("http://127.0.0.1:"+server.getAddress().getPort()+payload.getString("path"));
        HttpURLConnection connection=(HttpURLConnection)url.openConnection();connection.setConnectTimeout(2000);connection.setReadTimeout(6000);connection.setRequestMethod(payload.optString("method","GET"));
        JSONObject headers=payload.optJSONObject("headers");if(headers!=null)for(String name:headers.keySet())connection.setRequestProperty(name,headers.getString(name));
        if(payload.has("body")){connection.setDoOutput(true);connection.getOutputStream().write(payload.getString("body").getBytes(StandardCharsets.UTF_8));}
        try{int status=connection.getResponseCode();InputStream input=status>=400?connection.getErrorStream():connection.getInputStream();byte[] bytes=input==null?new byte[0]:input.readAllBytes();return new JSONObject().put("status",status).put("body",new String(bytes,StandardCharsets.UTF_8)).put("bodyBase64",Base64.getEncoder().encodeToString(bytes));}finally{connection.disconnect();}
      }catch(Exception error){throw new IllegalStateException(error);}
    };
    try {
      AgentPlugin first=new AgentPlugin();ok(read(first),"valid common read");check("Bearer owner-token".equals(lastBearer),"owner bearer replaces root");
      PluginCall me=call("/api/auth/me","GET",null);first.request(me);ok(me,"auth read");check(me.result!=null&&!me.result.toString().contains("owner-token")&&!me.result.has("bodyBase64"),"auth bearer redacted");
      String[] variants={"/api/auth/me?probe=1","/api/auth/me?","/api/config/"," /api/config ","/api/%63onfig","/api/a/../config","/api/%2e/config","/api/a/%2e%2e/config","/api%2fconfig","/api\\config","/api//config","/api/config#fragment","/api/agent/events?after=1&after=2","/api/update/status?force=false"};
      for(String path:variants){int before=requests;PluginCall c=call(path,"GET",null);first.request(c);denied(c,"alias refused: "+path);check(requests==before,"alias reached transport: "+path);}
      for(String method:new String[]{"get"," GET "}){int before=requests;PluginCall c=call("/api/config",method,null);first.request(c);denied(c,"normalized method refused");check(before==requests,"normalized method reached transport");}
      int before=requests;PluginCall c=call("/api/config","GET","");first.request(c);denied(c,"GET body refused");check(before==requests,"GET body reached transport");
      before=requests;c=call("/api/auth/me","GET",null);first.requestStream(c);denied(c,"common stream refused");check(before==requests,"common stream reached transport");
      c=call("/api/config/reload","POST","{}");first.request(c);ok(c,"unrelated legacy mutation preserved");check("POST".equals(lastMethod)&&"{}".equals(lastBody)&&"Bearer root".equals(lastBearer),"unrelated mutation authority unchanged");
      for(String[] route:new String[][]{{"/api/first-run","POST"},{"/api/config","PUT"},{"/api/character","PUT"},{"/api/stream/settings","POST"}}){
        c=call(route[0],route[1],"{\"exact\":\"payload\"}");first.request(c);ok(c,"shared setup write "+route[0]);check(route[1].equals(lastMethod)&&"{\"exact\":\"payload\"}".equals(lastBody)&&"Bearer owner-token".equals(lastBearer),"exact setup body and owner "+route[0]);
        for(String invalidBody:new String[]{null,"","  ","\u00e9".repeat(5*1024*1024+1)}){before=requests;c=call(route[0],route[1],invalidBody);first.request(c);denied(c,"invalid setup body");check(before==requests,"invalid body reached socket");}
      }
      c=call("/api/first-run","POST","{}");c.input.put("headers",new JSONObject().put("idempotency-key","setup operation:one/v2").put("x-elizaos-client-id","fixture-client"));first.request(c);ok(c,"normalized HTTP headers");check("setup operation:one/v2".equals(lastIdempotency)&&"fixture-client".equals(lastClient),"first-run idempotency value and lowercase client header preserved");
      before=requests;c=call("/api/first-run","POST","{}");c.input.put("ownerId","previous-owner");first.request(c);ok(c,"changed owner has a response");check(c.result!=null&&c.result.optInt("status")==409&&requests==before,"changed owner cannot mutate first-run");
      for(JSONObject headers:new JSONObject[]{new JSONObject().put("Idempotency-Key","a").put("idempotency-key","b"),new JSONObject().put("Idempotency-Key","bad\r\nvalue"),new JSONObject().put("Idempotency-Key","\tvalue"),new JSONObject().put("Idempotency-Key"," "),new JSONObject().put("Idempotency-Key","a".repeat(513)),new JSONObject().put("Idempotency-Key",42)}){before=requests;c=call("/api/first-run","POST","{}");c.input.put("headers",headers);first.request(c);denied(c,"invalid first-run header");check(before==requests,"invalid header reached socket");}
      String activation="/api/first-run/activation/12345678-1234-1234-1234-123456789abc";
      for(String path:new String[]{activation,"/api/config/schema","/api/character/schema"}){c=call(path,"GET",null);first.request(c);ok(c,"shared setup read "+path);check("Bearer owner-token".equals(lastBearer),"setup read owner");}
      for(String path:new String[]{"/api/%66irst-run","/api//first-run","/api/config?extra=1","/api/first-run#fragment","/api/first-run/activation/not-an-id"}){before=requests;c=call(path,"POST","{}");first.request(c);denied(c,"setup alias refused");check(before==requests,"setup alias reached transport");}
      c=call("/api/conversations","GET",null);first.request(c);ok(c,"unrelated legacy read preserved");
      held=new CountDownLatch(1);release=new CountDownLatch(1);CountDownLatch entered=held;PluginCall changedRoot=call("/api/first-run","POST","{}");Thread pending=thread(()->first.request(changedRoot));await(entered);ElizaAgentService.currentLocalAgentToken="successor-root";release.countDown();join(pending);denied(changedRoot,"old-root setup response retired");ElizaAgentService.currentLocalAgentToken="root";
      held=new CountDownLatch(1);release=new CountDownLatch(1);entered=held;PluginCall stale=call("/api/first-run","POST","{}");pending=thread(()->first.request(stale));await(entered);
      PluginCall stop=new PluginCall(new JSObject());first.stop(stop);ok(stop,"stop dispatch acknowledged");AgentPlugin replacement=new AgentPlugin();before=requests;denied(read(replacement),"stop blocks new Activity read");check(before==requests,"stopped read reached enrollment");first.handleOnDestroy();denied(read(replacement),"Activity destroy cannot reopen admission");release.countDown();join(pending);denied(stale,"held old response retired");
      replacement.start(new PluginCall(new JSObject()));denied(read(replacement),"queued start alone cannot reopen admission");
      CountDownLatch launchEntered=new CountDownLatch(1),launchRelease=new CountDownLatch(1);CountDownLatch enter1=launchEntered,release1=launchRelease;ElizaAgentService.launch=()->{enter1.countDown();await(release1);};Thread starting=thread(()->new ElizaAgentService().finishStart());await(launchEntered);denied(read(replacement),"held real start remains closed");launchRelease.countDown();join(starting);ok(read(replacement),"sequenced start opens admission");
      launchEntered=new CountDownLatch(1);launchRelease=new CountDownLatch(1);CountDownLatch enter2=launchEntered,release2=launchRelease;ElizaAgentService.launch=()->{enter2.countDown();await(release2);};starting=thread(()->new ElizaAgentService().finishStart());await(launchEntered);replacement.stop(new PluginCall(new JSObject()));launchRelease.countDown();join(starting);denied(read(replacement),"late start cannot reopen successor stop");
      ElizaAgentService.launch=()->{};ElizaAgentService.launchAccepted=false;new ElizaAgentService().finishStart();denied(read(replacement),"refused native start cannot reopen retained root");ElizaAgentService.launchAccepted=true;new ElizaAgentService().finishStart();ok(read(replacement),"later owned start recovers");
      android.content.Context.fail=true;c=new PluginCall(new JSObject());replacement.stop(c);denied(c,"failed stop dispatch visible");denied(read(new AgentPlugin()),"failed stop stays closed");android.content.Context.fail=false;new ElizaAgentService().finishStart();ok(read(replacement),"recovery follows sequenced start");
      AgentPlugin finalActivity=new AgentPlugin();before=pairs;replacement.handleOnDestroy();ok(read(finalActivity),"destroy only retires its Activity");check(pairs==before,"Activity replacement retains process owner cache");
      if(!failures.isEmpty())throw new AssertionError(String.join("\n",failures));
      System.out.println("PASS canonical native owner dispatch: "+checks+" checks; real HTTP, production parser, held lifecycle and Activity cases");
    } finally {server.stop(0);workers.shutdownNow();}
  }
}
