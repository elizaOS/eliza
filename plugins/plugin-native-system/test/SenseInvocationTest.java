package ai.eliza.plugins.system;

public final class SenseInvocationTest {
    private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    private static final String OWNER="11111111-1111-4111-8111-111111111111", NEXT="22222222-2222-4222-8222-222222222222";
    private static final String A="a".repeat(64), B="b".repeat(64);
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
        }
        System.out.println("PASS native Sense invocation ownership and replay fences");
    }
}
