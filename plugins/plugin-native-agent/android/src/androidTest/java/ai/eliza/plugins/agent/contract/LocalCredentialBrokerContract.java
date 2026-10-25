package ai.eliza.plugins.agent.contract;

import ai.eliza.plugins.agent.runtime.LocalCredentialBroker;
import java.io.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Android/JVM contract using independent stores and real TCP, without a product dependency. */
public final class LocalCredentialBrokerContract {
  private static final class MemoryStore implements LocalCredentialBroker.Store {
    String value;
    int calls;
    boolean fail;
    public String read() throws Exception { calls++; if (fail) throw new IOException("private-storage-detail"); return value; }
    public void write(String value) { calls++; this.value = value; }
    public void clear() { calls++; value = null; }
  }
  public static void main(String[] args) throws Exception { run(); System.out.println("Credential broker socket contract passed"); }
  public static void run() throws Exception {
    verifiedAccountContract();
    taskKeyContract();
    taskKeyRetirementContract();
    MemoryStore primary = new MemoryStore(), pending = new MemoryStore();
    try { new LocalCredentialBroker(primary, pending, ""); throw new AssertionError("Empty token accepted"); }
    catch (IllegalArgumentException expected) { }
    try (LocalCredentialBroker broker = new LocalCredentialBroker(primary, pending, "contract-token")) {
      String write = "{\"operation\":\"write\",\"value\":\"synthetic-primary\"}";
      for (String header : new String[]{"Origin: https://example.test\r\n", "Transfer-Encoding: chunked\r\n", "Authorization: Bearer contract-token\r\n", "Content-Length: -1\r\n"}) {
        check(exchange(broker.port(), header, write, "contract-token", "POST /credential HTTP/1.1", null), 403);
      }
      check(exchange(broker.port(), "", write, "wrong-token", "POST /credential HTTP/1.1", null), 403);
      check(exchange(broker.port(), "", write, "contract-token", "GET /credential HTTP/1.1", null), 403);
      check(exchange(broker.port(), "", "", "contract-token", "POST /credential HTTP/1.1", 20001), 413);
      require(primary.calls == 0 && pending.calls == 0, "Rejected requests accessed storage");
      check(exchange(broker.port(), "", write, "contract-token", "POST /credential HTTP/1.1", null), 200);
      check(operation(broker, "pending-write", "synthetic-pending"), 200);
      require(operation(broker, "read", null).getJSONObject("body").getString("value").equals("synthetic-primary"), "Primary changed");
      require(operation(broker, "pending-read", null).getJSONObject("body").getString("value").equals("synthetic-pending"), "Pending changed");
      check(operation(broker, "pending-clear", null), 200);
      require(pending.value == null && primary.value.equals("synthetic-primary"), "Store separation failed");
      check(operation(broker, "task-key-read", null), 503);
      int before = primary.calls;
      check(operation(broker, "unsupported", null), 503);
      check(exchange(broker.port(), "", "{", "contract-token", "POST /credential HTTP/1.1", null), 503);
      require(primary.calls == before, "Malformed operation accessed storage");
      primary.fail = true;
      JSONObject failed = operation(broker, "read", null); check(failed, 503);
      require(!failed.toString().contains("private-storage-detail"), "Storage details leaked");
      primary.fail = false;
      check(operation(broker, "clear", null), 200);
      require(operation(broker, "read", null).getJSONObject("body").isNull("value"), "Clear failed");
    }
  }
  private static void verifiedAccountContract() throws Exception {
    final String[] raw = {null}; final int[] calls = {0};
    final boolean[] retired = {false};
    LocalCredentialBroker.Guard guard = () -> { if (retired[0]) throw new IOException("private-owner-canary"); };
    LocalCredentialBroker.VerifiedAccountStore verified = new LocalCredentialBroker.VerifiedAccountStore() {
      public String read() { calls[0]++; return raw[0]; }
      public boolean compareExchange(String expected, String next) {
        calls[0]++; if (!java.util.Objects.equals(expected, raw[0])) return false; raw[0]=next; return true;
      }
    };
    MemoryStore legacy = new MemoryStore();
    try (LocalCredentialBroker broker = new LocalCredentialBroker(legacy, new MemoryStore(), "contract-token", null, null, verified, guard)) {
      check(operation(broker,"write","unverified"),503);
      check(operation(broker,"clear",null),503);
      require(legacy.calls==0 && calls[0]==0,"Legacy bypass reached verified storage");
      String record = new JSONObject().put("credential","synthetic-private-key").toString();
      JSONObject request = new JSONObject().put("operation","verified-account-exchange").put("expected",JSONObject.NULL).put("value",record);
      JSONObject first = exchange(broker.port(),"",request.toString(),"contract-token","POST /credential HTTP/1.1",null);
      require(first.getJSONObject("body").getBoolean("exchanged"),"Initial exchange failed");
      require(!exchange(broker.port(),"",request.toString(),"contract-token","POST /credential HTTP/1.1",null).getJSONObject("body").getBoolean("exchanged"),"Stale snapshot replaced record");
      require(operation(broker,"read",null).getJSONObject("body").getString("value").equals("synthetic-private-key"),"Legacy read projection failed");
      require(operation(broker,"verified-account-read",null).getJSONObject("body").getString("value").equals(record),"Snapshot changed");
      int before = calls[0];
      request.put("accountId","injected");check(exchange(broker.port(),"",request.toString(),"contract-token","POST /credential HTTP/1.1",null),503);
      require(calls[0]==before,"Wire identity accessed store");
      final JSONObject[] response={null};
      Thread queued = new Thread(() -> {try {response[0]=operation(broker,"verified-account-read",null);}catch(Exception e){throw new RuntimeException(e);}});
      synchronized(guard) { queued.start(); Thread.sleep(100); retired[0]=true; }
      queued.join(5000);require(!queued.isAlive(),"Queued request hung");check(response[0],503);
      require(calls[0]==before && !response[0].toString().contains("canary"),"Retired queued read reached store or leaked");
    }
    retired[0]=false;
    LocalCredentialBroker.VerifiedAccountStore retiresDuringWrite = new LocalCredentialBroker.VerifiedAccountStore() {
      public String read() { retired[0]=true; return "private-record-canary"; }
      public boolean compareExchange(String expected,String next) { retired[0]=true; return true; }
    };
    for (String operation : new String[]{"verified-account-read","verified-account-exchange"}) {
      retired[0]=false;
      try(LocalCredentialBroker broker=new LocalCredentialBroker(new MemoryStore(),new MemoryStore(),"contract-token",null,null,retiresDuringWrite,guard)) {
        JSONObject body=new JSONObject().put("operation",operation);
        if(operation.endsWith("exchange"))body.put("expected",JSONObject.NULL).put("value",JSONObject.NULL);
        JSONObject result=exchange(broker.port(),"",body.toString(),"contract-token","POST /credential HTTP/1.1",null);
        check(result,503);require(!result.toString().contains("canary"),"Retired result leaked");
      }
    }
  }
  private static void taskKeyContract() throws Exception {
    final String record = "{\"version\":1,\"id\":\"12345678-1234-1234-1234-123456789abc\",\"key\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\"}";
    final int[] calls = {0};
    final boolean[] present = {false};
    LocalCredentialBroker.TaskKeyCustody keys = new LocalCredentialBroker.TaskKeyCustody() {
      public String read() { calls[0]++; return present[0] ? record : null; }
      public String createForNewDatabase() { calls[0]++; present[0] = true; return record; }
      public boolean remove(String id) { calls[0]++; if (!id.equals("12345678-1234-1234-1234-123456789abc")) return false; boolean removed=present[0];present[0]=false;return removed; }
    };
    final class OwnerGuard implements LocalCredentialBroker.Guard {
      int checks; int refuseAt = Integer.MAX_VALUE;
      public void check() throws Exception {
        require(Thread.holdsLock(this), "Owner operation is not serialized");
        if (++checks >= refuseAt) throw new IOException("private-owner-detail");
      }
    }
    OwnerGuard guard = new OwnerGuard();
    try (LocalCredentialBroker broker = new LocalCredentialBroker(new MemoryStore(), new MemoryStore(), "contract-token", keys, guard)) {
      require(operation(broker,"task-key-read",null).getJSONObject("body").isNull("value"),"Missing key changed");
      check(exchange(broker.port(),"","{\"operation\":\"task-key-create\",\"accountId\":\"other\"}","contract-token","POST /credential HTTP/1.1",null),503);
      require(calls[0]==1,"Wire identity reached custody");
      require(operation(broker,"task-key-create",null).getJSONObject("body").getString("value").equals(record),"Create changed key");
      require(operation(broker,"task-key-read",null).getJSONObject("body").getString("value").equals(record),"Read changed key");
      require(!operation(broker,"task-key-remove","87654321-1234-1234-1234-123456789abc").getJSONObject("body").getBoolean("removed"),"Stale generation removed key");
      guard.refuseAt=guard.checks+2;
      JSONObject retired=operation(broker,"task-key-read",null);check(retired,503);
      require(!retired.toString().contains(record) && !retired.toString().contains("private-owner-detail"),"Retired response leaked");
      int before=calls[0];check(operation(broker,"task-key-create",null),503);require(calls[0]==before,"Retired owner mutated custody");
      guard.refuseAt=Integer.MAX_VALUE;
      require(operation(broker,"task-key-remove","12345678-1234-1234-1234-123456789abc").getJSONObject("body").getBoolean("removed"),"Remove failed");
    }
  }
  private static void taskKeyRetirementContract() throws Exception {
    final class OwnerGuard implements LocalCredentialBroker.Guard {
      boolean active = true;
      public void check() throws Exception { if (!active) throw new IOException("synthetic-owner-canary"); }
    }
    for (String mode : new String[]{"waiting", "closed", "create", "remove"}) {
      OwnerGuard guard = new OwnerGuard(); final int[] calls = {0};
      LocalCredentialBroker.TaskKeyCustody keys = new LocalCredentialBroker.TaskKeyCustody() {
        public String read() { calls[0]++; return "synthetic-key-canary"; }
        public String createForNewDatabase() { calls[0]++;guard.active=false;return "synthetic-key-canary"; }
        public boolean remove(String id) { calls[0]++;guard.active=false;return true; }
      };
      try (LocalCredentialBroker broker = new LocalCredentialBroker(new MemoryStore(),new MemoryStore(),"contract-token",keys,guard)) {
        JSONObject response;
        if (mode.equals("waiting") || mode.equals("closed")) {
          java.util.concurrent.FutureTask<JSONObject> request = new java.util.concurrent.FutureTask<>(() -> operation(broker,"task-key-read",null));
          synchronized (guard) {
            Thread caller = new Thread(request,"TaskKeyRetirementClient");caller.start();
            long deadline = System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            boolean waiting=false;
            while (System.nanoTime()<deadline && !waiting) {
              for (Thread thread:Thread.getAllStackTraces().keySet()) {
                if(thread.getName().equals("AccountCredentialBroker") && thread.getState()==Thread.State.BLOCKED) waiting=true;
              }
              if(!waiting)Thread.sleep(5);
            }
            require(waiting,"Broker did not wait on owner mutex");
            if(mode.equals("closed"))broker.close();else guard.active=false;
          }
          response=request.get(5,java.util.concurrent.TimeUnit.SECONDS);
          require(calls[0]==0,"Queued retired broker accessed custody");
        } else {
          response=operation(broker,"task-key-"+mode,mode.equals("remove")?"12345678-1234-1234-1234-123456789abc":null);
          require(calls[0]==1,"Mutation did not execute once");
        }
        check(response,503);
        require(response.getJSONObject("body").getString("error").equals("Native account storage unavailable"),"Unexpected public error");
        require(!response.toString().contains("canary"),"Retired key/owner leaked");
      }
    }
  }
  private static JSONObject operation(LocalCredentialBroker broker, String operation, String value) throws Exception {
    JSONObject body = new JSONObject().put("operation", operation);
    if (value != null) body.put("value", value);
    return exchange(broker.port(), "", body.toString(), "contract-token", "POST /credential HTTP/1.1", null);
  }
  private static void check(JSONObject response, int status) throws Exception { require(response.getInt("status") == status, "Unexpected status: " + response.getInt("status")); }
  private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
  private static JSONObject exchange(int port, String extra, String body, String token, String request, Integer length) throws Exception {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    try (Socket socket = new Socket("127.0.0.1", port)) {
      socket.setSoTimeout(5000);
      socket.getOutputStream().write((request + "\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token + "\r\n" + extra + "Content-Length: " + (length == null ? bytes.length : length) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      socket.getOutputStream().write(bytes);
      BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
      int status = Integer.parseInt(reader.readLine().split(" ")[1]);
      String header; boolean noStore = false;
      while (!(header = reader.readLine()).isEmpty()) if (header.equals("Cache-Control: no-store")) noStore = true;
      require(noStore, "Response must prevent caching");
      StringBuilder result = new StringBuilder(); int c;
      while ((c = reader.read()) != -1) result.append((char)c);
      return new JSONObject().put("status", status).put("body", new JSONObject(result.toString()));
    }
  }
}
