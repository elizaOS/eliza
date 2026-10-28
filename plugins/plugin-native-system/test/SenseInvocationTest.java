package ai.eliza.plugins.system;

public final class SenseInvocationTest {
    private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    private static final String OWNER="11111111-1111-4111-8111-111111111111", NEXT="22222222-2222-4222-8222-222222222222";
    private static final String A="a".repeat(64), B="b".repeat(64);
    /** A wake before any authenticated binding: only a native owner admission can let a session claim it. */
    private static void coldStart(String host) {
        String[] nativeOwner = {"account-1"};
        java.util.function.Supplier<SenseInvocation> fresh = () -> {
            SenseInvocation state = new SenseInvocation();
            state.admit(() -> nativeOwner[0]);
            return state;
        };
        // Cold process: the wake arrives first; the renderer mounts unauthenticated, then signs in.
        SenseInvocation cold = fresh.get();
        cold.record(host, host + ".sense", true, 100, false);
        cold.bind(1, 1, OWNER, null, 200);
        check(cold.take(1, 1, OWNER, A, 300, false) == null, "an unauthenticated renderer cannot consume");
        cold = fresh.get();
        cold.record(host, host + ".sense", true, 100, false);
        cold.bind(1, 1, OWNER, null, 200);
        cold.bind(1, 1, OWNER, A, 6000);
        check("listener".equals(cold.take(1, 1, OWNER, A, 9000, false)), "same native owner claims a cold wake within the cold window");
        check(cold.take(1, 1, OWNER, A, 9001, false) == null, "a claimed cold wake is consumed once");
        // Once a session is bound, later wakes are warm: the short window and session fence apply.
        cold.record(host, host + ".sense", true, 10000, false);
        check("assist".equals(cold.take(1, 1, OWNER, A, 10000 + SenseInvocation.WINDOW_MS + 1, false)), "a warm wake keeps the short window");
        // The first binding of a new plugin lifetime (the usual cold process) claims it too.
        SenseInvocation first = fresh.get();
        first.record(host, host + ".sense", true, 1000, false);
        first.bind(1, 1, OWNER, A, 4000);
        check("listener".equals(first.take(1, 1, OWNER, A, 4100, false)), "first binding claims a wake recorded before it");
        // A renderer signed out again (null session) can receive a cold wake as well.
        first.bind(1, 1, OWNER, null, 5000);
        first.record(host, host + ".sense", true, 5100, false);
        first.bind(1, 1, OWNER, B, 5200);
        check("listener".equals(first.take(1, 1, OWNER, B, 5300, false)), "a signed-out renderer's next session claims the wake");
        // The native owner changed between the wake and the binding: dropped, not reassigned.
        SenseInvocation changed = fresh.get();
        changed.record(host, host + ".sense", true, 100, false);
        nativeOwner[0] = "account-2";
        changed.bind(1, 1, OWNER, B, 200);
        check(changed.take(1, 1, OWNER, B, 300, false) == null, "an owner change drops the cold wake");
        nativeOwner[0] = "account-1";
        // The owner changes after the claim but before the take: open the assistant only.
        SenseInvocation late = fresh.get();
        late.record(host, host + ".sense", true, 100, false);
        late.bind(1, 1, OWNER, A, 200);
        nativeOwner[0] = "account-3";
        check("assist".equals(late.take(1, 1, OWNER, A, 300, false)), "the native owner must still match at the take");
        nativeOwner[0] = "account-1";
        // Expiry: the binding arrives after the cold window, or the take does.
        SenseInvocation expired = fresh.get();
        expired.record(host, host + ".sense", true, 100, false);
        expired.bind(1, 1, OWNER, A, 100 + SenseInvocation.COLD_WINDOW_MS + 1);
        check(expired.take(1, 1, OWNER, A, 100 + SenseInvocation.COLD_WINDOW_MS + 2, false) == null, "a late binding cannot claim an expired wake");
        expired = fresh.get();
        expired.record(host, host + ".sense", true, 100, false);
        expired.bind(1, 1, OWNER, A, 200);
        check("assist".equals(expired.take(1, 1, OWNER, A, 100 + SenseInvocation.COLD_WINDOW_MS + 1, false)), "the cold window bounds the take");
        // Lock, signer, caller and clock rules still apply.
        SenseInvocation rule = fresh.get();
        rule.record(host, host + ".sense", true, 100, true);
        rule.bind(1, 1, OWNER, A, 200);
        check(rule.take(1, 1, OWNER, A, 300, false) == null, "a wake while locked is never held");
        rule = fresh.get();
        rule.record(host, host + ".sense", false, 100, false);
        rule.bind(1, 1, OWNER, A, 200);
        check(rule.take(1, 1, OWNER, A, 300, false) == null, "a different signer is never held");
        rule = fresh.get();
        rule.record(host, "other.sense", true, 100, false);
        rule.bind(1, 1, OWNER, A, 200);
        check(rule.take(1, 1, OWNER, A, 300, false) == null, "another caller is never held");
        rule = fresh.get();
        rule.record(host, host + ".sense", true, 100, false);
        rule.bind(1, 1, OWNER, A);
        check(rule.take(1, 1, OWNER, A, 300, false) == null, "no clock, no claim");
        rule = fresh.get();
        rule.record(host, host + ".sense", true, 100, false);
        rule.bind(1, 1, OWNER, A, 200);
        rule.record(host, null, false, 250, false);
        check("assist".equals(rule.take(1, 1, OWNER, A, 300, false)), "a later non-listener launch replaces the claimed wake");
        rule = fresh.get();
        rule.record(host, host + ".sense", true, 100, false);
        rule.bind(1, 1, OWNER, A, 200);
        check("assist".equals(rule.take(1, 1, OWNER, A, 300, true)), "locked or background at the take");
        // A failing, oversized or absent admission is no owner.
        nativeOwner[0] = null;
        rule = fresh.get();
        rule.record(host, host + ".sense", true, 100, false);
        rule.bind(1, 1, OWNER, A, 200);
        check(rule.take(1, 1, OWNER, A, 300, false) == null, "no admitted owner admits nothing");
        nativeOwner[0] = "account-1";
        SenseInvocation failing = new SenseInvocation();
        failing.admit(() -> { throw new IllegalStateException("store unavailable"); });
        failing.record(host, host + ".sense", true, 100, false);
        failing.bind(1, 1, OWNER, A, 200);
        check(failing.take(1, 1, OWNER, A, 300, false) == null, "an unavailable owner admits nothing");
        failing = new SenseInvocation();
        failing.admit(() -> "x".repeat(257));
        failing.record(host, host + ".sense", true, 100, false);
        failing.bind(1, 1, OWNER, A, 200);
        check(failing.take(1, 1, OWNER, A, 300, false) == null, "an oversized owner identity admits nothing");
        failing = fresh.get();
        failing.admit(null);
        failing.record(host, host + ".sense", true, 100, false);
        failing.bind(1, 1, OWNER, A, 200);
        check(failing.take(1, 1, OWNER, A, 300, false) == null, "removing the admission restores assist-only cold starts");
        // Stale renderer generations cannot claim it; the current mount still can.
        SenseInvocation stale = fresh.get();
        stale.bind(1, 2, NEXT, null, 50);
        stale.record(host, host + ".sense", true, 100, false);
        stale.bind(1, 1, OWNER, A, 200);
        check(stale.take(1, 1, OWNER, A, 300, false) == null, "an older renderer mount cannot claim a cold wake");
        stale.bind(1, 2, NEXT, A, 300);
        check("listener".equals(stale.take(1, 2, NEXT, A, 400, false)), "the current mount still can");
        // Reset for data erases a held wake.
        SenseInvocation erased = fresh.get();
        erased.record(host, host + ".sense", true, 100, false);
        erased.reset();
        erased.bind(1, 1, OWNER, A, 200);
        check(erased.take(1, 1, OWNER, A, 300, false) == null, "reset drops a held cold wake");
    }

    /** A system assistant gesture (platform system UI caller) follows the listener's voice rules. */
    private static void systemGesture(String host) {
        SenseInvocation warm = new SenseInvocation();
        warm.bind(1, 1, OWNER, A);
        warm.record(host, "com.android.systemui", false, true, 100, false);
        check(SenseInvocation.SYSTEM.equals(warm.take(1, 1, OWNER, A, 101, false)), "a bound session takes a system gesture");
        check(warm.take(1, 1, OWNER, A, 102, false) == null, "a system gesture is consumed once");
        warm.record(host, "com.android.systemui", false, true, 100, false);
        check(SenseInvocation.ASSIST.equals(warm.take(1, 1, OWNER, A, 100 + SenseInvocation.WINDOW_MS + 1, false)), "a system gesture keeps the short window");
        warm.record(host, "com.android.systemui", false, true, 100, true);
        check(SenseInvocation.ASSIST.equals(warm.take(1, 1, OWNER, A, 101, false)), "a system gesture while locked only opens");
        warm.record(host, "com.android.systemui", false, true, 100, false);
        check(SenseInvocation.ASSIST.equals(warm.take(1, 1, OWNER, A, 101, true)), "locked or background at the take only opens");
        warm.record(host, "com.android.systemui", false, true, 100, false);
        check(SenseInvocation.ASSIST.equals(warm.take(1, 1, OWNER, B, 101, false)), "another session cannot take a system gesture");
        warm.record(host, "com.android.systemui", false, false, 100, false);
        check(SenseInvocation.ASSIST.equals(warm.take(1, 1, OWNER, A, 101, false)), "an unverified system UI caller only opens");
        // The listener caller keeps its own origin even if a host marked it as a system gesture.
        warm.record(host, host + ".sense", true, true, 100, false);
        check(SenseInvocation.LISTENER.equals(warm.take(1, 1, OWNER, A, 101, false)), "a listener wake stays a listener wake");
        // An account change between the gesture and the take clears it.
        warm.record(host, "com.android.systemui", false, true, 100, false);
        warm.bind(1, 1, OWNER, B);
        check(warm.take(1, 1, OWNER, B, 101, false) == null, "an account change clears a system gesture");
        // Cold start: held only with a native owner admission, and claimed with its origin kept.
        String[] nativeOwner = {"account-1"};
        SenseInvocation cold = new SenseInvocation();
        cold.admit(() -> nativeOwner[0]);
        cold.record(host, "com.android.systemui", false, true, 100, false);
        cold.bind(1, 1, OWNER, null, 200);
        cold.bind(1, 1, OWNER, A, 6000);
        check(SenseInvocation.SYSTEM.equals(cold.take(1, 1, OWNER, A, 9000, false)), "the same native owner claims a cold system gesture");
        cold = new SenseInvocation();
        cold.admit(() -> nativeOwner[0]);
        cold.record(host, "com.android.systemui", false, true, 100, false);
        nativeOwner[0] = "account-2";
        cold.bind(1, 1, OWNER, A, 200);
        check(cold.take(1, 1, OWNER, A, 300, false) == null, "an owner change drops a cold system gesture");
        SenseInvocation unadmitted = new SenseInvocation();
        unadmitted.record(host, "com.android.systemui", false, true, 100, false);
        unadmitted.bind(1, 1, OWNER, A, 200);
        check(unadmitted.take(1, 1, OWNER, A, 300, false) == null, "without an owner admission a cold system gesture is not held");
    }

    public static void main(String[] args) {
        for (String host : new String[]{"ai.elizaos.app", "ai.elizaresearch.alphaphone"}) {
            SenseInvocation state=new SenseInvocation();
            state.record(host,host+".sense",true,100,false);
            state.bind(1, 1, OWNER, A);check(state.take(1, 1, OWNER, A,101,false)==null,"cold-start cannot inherit unbound wake");
            state.record(host,host+".sense",true,100,false);
            check("listener".equals(state.take(1, 1, OWNER, A,5100,false)),"same owner within exact window");
            check(state.take(1, 1, OWNER, A,5101,false)==null,"consumed once");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(1, 1, OWNER, A,5101,false)),"expired");
            state.record(host,host+".sense",true,100,false);
            state.bind(1, 1, OWNER, B);check(state.take(1, 1, OWNER, B,101,false)==null,"account change clears wake");
            state.bind(1, 1, OWNER, A);check(state.take(1, 1, OWNER, A,101,false)==null,"old account cannot replay");
            state.record(host,host+".sense",false,100,false);
            check("assist".equals(state.take(1, 1, OWNER, A,101,false)),"wrong signer");
            state.record(host,"other.sense",true,100,false);
            check("assist".equals(state.take(1, 1, OWNER, A,101,false)),"wrong caller");
            state.record(host,host+".sense",true,100,true);
            check("assist".equals(state.take(1, 1, OWNER, A,101,false)),"locked at arrival");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(1, 1, OWNER, A,101,true)),"locked or background now");
            state.record(host,host+".sense",true,100,false);
            check("assist".equals(state.take(1, 1, OWNER, B,101,false)),"wrong claiming session");
            state.record(host,host+".sense",true,100,false);
            state.record(host,null,false,101,false);
            check("assist".equals(state.take(1, 1, OWNER, A,102,false)),"recreation/repeated non-listener intent replaces old wake");
            state.bind(1, 2, NEXT, A);
            state.record(host,host+".sense",true,100,false);
            state.bind(1, 1, OWNER, null);
            check(state.take(1, 1, OWNER, A,101,false)==null,"old controller cannot consume new owner's receipt");
            check("listener".equals(state.take(1, 2, NEXT,A,101,false)),"delayed old cleanup preserves same-session new binding");
            state.bind(1,1,OWNER,A); state.bind(1,1,OWNER,null);
            state.record(host,host+".sense",true,100,false);
            check("listener".equals(state.take(1,2,NEXT,A,101,false)),"late old bind cannot replace newer renderer");
            state.bind(2,1,OWNER,A); state.record(host,host+".sense",true,100,false);
            state.bind(1,3,NEXT,A); state.release(1);
            check(state.take(1,3,NEXT,A,101,false)==null,"old plugin cannot consume after WebView replacement");
            check("listener".equals(state.take(2,1,OWNER,A,101,false)),"old plugin bind and destroy cannot reset new plugin");
            try {state.bind(1, 1, OWNER, "credential");throw new AssertionError("invalid key");} catch (IllegalArgumentException expected) {}
            coldStart(host);
            systemGesture(host);
        }
        SenseInvocation power=new SenseInvocation();
        check(!power.recordProtectedPower(1,100,false),"cold power never queues");
        power.bind(1,1,OWNER,A);check(power.take(1,1,OWNER,A,101,false)==null,"first bind cannot promote power");
        check(power.recordProtectedPower(1,100,false),"warm bound power recorded");
        check("power".equals(power.take(1,1,OWNER,A,101,false)),"warm matching power");
        check(power.take(1,1,OWNER,A,102,false)==null,"power consumed once");
        power.recordProtectedPower(1,100,false);power.discardProtectedPower(1,1,NEXT,A);
        check("power".equals(power.take(1,1,OWNER,A,101,false)),"foreign discard cannot consume");
        power.recordProtectedPower(1,100,false);power.discardProtectedPower(1,1,OWNER,A);
        check(power.take(1,1,OWNER,A,101,false)==null,"matching blocked power discarded");
        power.record("ai.elizaos.app","ai.elizaos.app.sense",true,100,false);power.discardProtectedPower(1,1,OWNER,A);
        check("listener".equals(power.take(1,1,OWNER,A,101,false)),"power discard preserves listener");
        power.recordProtectedPower(1,100,false);power.bind(1,1,OWNER,B);check(power.take(1,1,OWNER,B,101,false)==null,"account switch clears power");
        power.bind(1,1,OWNER,A);power.recordProtectedPower(1,100,false);power.bind(2,1,NEXT,A);check(power.take(2,1,NEXT,A,101,false)==null,"new bridge clears power");
        power.recordProtectedPower(2,100,false);power.bind(2,2,OWNER,A);check(power.take(2,2,OWNER,A,101,false)==null,"new renderer clears power");
        power.recordProtectedPower(2,100,true);check("assist".equals(power.take(2,2,OWNER,A,101,false)),"locked arrival never deferred");
        power.recordProtectedPower(2,100,false);check("assist".equals(power.take(2,2,OWNER,A,5101,false)),"power expires");
        power.recordProtectedPower(2,100,false);check("assist".equals(power.take(2,2,OWNER,A,101,true)),"locked read cannot capture");
        power.release(2);check(!power.recordProtectedPower(2,100,false),"released bridge cannot mint power");
        // A native owner admission never turns a protected Power receipt into a cold wait.
        SenseInvocation admittedPower=new SenseInvocation();admittedPower.admit(() -> "account-1");
        check(!admittedPower.recordProtectedPower(1,100,false),"admitted owner still cannot queue cold power");
        admittedPower.bind(1,1,OWNER,A,200);check(admittedPower.take(1,1,OWNER,A,300,false)==null,"admitted first bind cannot promote power");
        admittedPower.recordProtectedPower(1,400,false);admittedPower.bind(1,1,OWNER,null,500);admittedPower.bind(1,1,OWNER,A,600);
        check(admittedPower.take(1,1,OWNER,A,700,false)==null,"signed-out power is never carried to the next session");
        admittedPower.record("ai.elizaos.app","com.android.systemui",false,true,800,false);admittedPower.discardProtectedPower(1,1,OWNER,A);
        check("system".equals(admittedPower.take(1,1,OWNER,A,900,false)),"power discard preserves a system gesture");
        System.out.println("PASS native Sense invocation ownership and replay fences, listener, system gesture and protected power");
    }
}
