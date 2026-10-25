package ai.eliza.plugins.securestore.nativeonly;

import android.os.SystemClock;
import java.util.*;
import java.util.function.LongSupplier;

/** Ephemeral, one-shot capabilities. No credentials, Intent-supplied field ids, or disk state. */
public final class PasswordAutofillSessions {
  public static final class Session {
    public final PasswordAutofillRequest request;
    private final LongSupplier clock;
    private final long created;
    public volatile boolean cancelled;
    private volatile boolean consumed;
    Session(PasswordAutofillRequest request){this(request,SystemClock::elapsedRealtime);}
    Session(PasswordAutofillRequest request,LongSupplier clock){this.request=request;this.clock=Objects.requireNonNull(clock);this.created=clock.getAsLong();}
    public long remainingMillis(){long now=clock.getAsLong(),elapsed=now-created;return cancelled || consumed || created<0 || now<created || elapsed<0 || elapsed>=120000?0:120000-elapsed;}
    public boolean valid(){return remainingMillis()>0;}
  }
  private static final Map<String,Session> pending=new HashMap<>();
  private static Session current;
  private static String currentToken;
  public static synchronized void invalidate(){if(current!=null)current.cancelled=true;pending.clear();}
  public static synchronized String create(PasswordAutofillRequest request){
    invalidate();
    current=new Session(request);String token=UUID.randomUUID().toString();pending.put(token,current);currentToken=token;return token;
  }
  /** Atomically consumes the currently selected capability before publishing a result. */
  static synchronized boolean claim(Session session){
    if(session==null || session!=current || !session.valid())return false;
    session.consumed=true;session.cancelled=true;pending.clear();return true;
  }
  public static synchronized Session take(String token){Session session=pending.remove(token);return session!=null && session.valid()?session:null;}
  public static synchronized void cancel(String token){Session session=pending.remove(token);if(session!=null)session.cancelled=true; if(token.equals(currentToken) && current!=null)current.cancelled=true;}
}
