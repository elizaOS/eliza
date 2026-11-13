package ai.eliza.plugins.agent.runtime;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Native-issued, expiring request leases over the existing credential-intent fence.
 * No tombstones or completed requests are retained. Unknown/stale cancellations cannot reserve
 * a new credential intent, and cancelled/expired IDs can never begin a mutation. */
public final class CredentialRequestFence {
 private static final int LIMIT=64;
 private static final long LIFETIME_NANOS=120_000_000_000L;
 private static final class Lease {
  final long intent,expires;boolean begun;
  Lease(long intent,long expires){this.intent=intent;this.expires=expires;}
 }
 private final Object lock;
 private final CredentialIntentFence intents;
 private final LongSupplier clock;
 private final Map<String,Lease> requests=new HashMap<>();
 public CredentialRequestFence(Object lock,CredentialIntentFence intents){this(lock,intents,System::nanoTime);}
 public CredentialRequestFence(Object lock,CredentialIntentFence intents,LongSupplier clock){this.lock=lock;this.intents=intents;this.clock=clock;}
 private void prune(){long now=clock.getAsLong();requests.values().removeIf(lease->now-lease.expires>=0);}
 /** Reserve before passing any keys. The renderer can cancel this lease before configure arrives. */
 public String reserve(){synchronized(lock){
  prune();if(requests.size()>=LIMIT)throw new IllegalStateException("Too many pending credential requests");
  String id=UUID.randomUUID().toString();requests.put(id,new Lease(intents.reserve(),clock.getAsLong()+LIFETIME_NANOS));return id;
 }}
 public long begin(String id){synchronized(lock){prune();Lease lease=requests.get(id);if(lease==null||lease.begun)throw new IllegalStateException("Credential request unavailable");try{intents.require(lease.intent);}catch(IllegalStateException stale){requests.remove(id);throw stale;}lease.begun=true;return lease.intent;}}
 public void require(String id,long intent){synchronized(lock){prune();Lease lease=requests.get(id);if(lease==null||lease.intent!=intent)throw new IllegalStateException("Credential request cancelled");intents.require(intent);}}
 public void cancel(String id){synchronized(lock){prune();Lease lease=requests.remove(id);if(lease!=null&&intents.current()==lease.intent)intents.reserve();}}
 public void finish(String id,long intent){synchronized(lock){Lease lease=requests.get(id);if(lease!=null&&lease.intent==intent)requests.remove(id);}}
}
