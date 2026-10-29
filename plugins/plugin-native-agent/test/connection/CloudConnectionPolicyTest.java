package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.connection.CloudConnectionPolicy;
import java.util.Set;

/** Host-JVM checks of the Cloud transport route policy with Eliza Cloud's hosts. Not an Android or device test. */
public final class CloudConnectionPolicyTest {
 static final CloudConnectionPolicy ROUTES=new CloudConnectionPolicy(new CloudConnectionPolicy.Hosts(
  "api.eliza.app","api-staging.eliza.app","eliza.app","staging.eliza.app","cloud.eliza.app","cloud-staging.eliza.app",Set.of("accounts.google.com")));
 private static void check(boolean condition,String name){if(!condition)throw new AssertionError(name);}
 private static boolean revoke(String scheme,String host,int port,String path,String query,String method,boolean body,boolean mocks){
  return ROUTES.cloudSelfRevocation(scheme,host,port,path,query,method,body,mocks);
 }
 public static void main(String[] args){
  // Production builds never send a pairing code, whatever the spelling of the route.
  for(String path:new String[]{"/api/auth/pair","/api/auth/pair/","//api//auth/pair","/api/auth/pair//"})check(ROUTES.retiredPairing(path,false),"flag-off refuses "+path);
  // Session checks, pair-code display and unrelated routes are not the pairing mutation.
  for(String path:new String[]{"/api/auth/me","/api/auth/pair-code","/api/auth/status","/api/auth/logout","/api/auth/pairing","/api/v1/user","/",null})check(!ROUTES.retiredPairing(path,false),"flag-off keeps "+path);
  check(!ROUTES.retiredPairing("/api/auth/pair",true),"test-mocks builds keep development pairing");
  // #406: product builds declare nothing to a hosted or paired agent runtime over this transport.
  for(String name:new String[]{"accept","content-type","authorization"}){check(CloudConnectionPolicy.admittedHeader(name,false),"flag-off admits "+name);check(CloudConnectionPolicy.admittedHeader(name,true),"test mocks admit "+name);}
  for(String name:new String[]{"x-eliza-device-id","x-eliza-device-key","x-eliza-device-capabilities","x-eliza-phone-protocol"}){check(!CloudConnectionPolicy.admittedHeader(name,false),"flag-off refuses "+name);check(CloudConnectionPolicy.admittedHeader(name,true),"test mocks keep "+name);}
  for(String name:new String[]{"cookie","x-eliza-agent-id","Authorization","X-Eliza-Phone-Protocol","",null})check(!CloudConnectionPolicy.admittedHeader(name,true)&&!CloudConnectionPolicy.admittedHeader(name,false),"header "+name);

  for(String path:new String[]{"geocode","reverse","places/search","places/details","routes"})check(CloudConnectionPolicy.mapsRequestIdentity("idempotency-key","request_1","/api/v1/maps/"+path,"POST"),"Maps request identity "+path);
  for(String path:new String[]{"/api/v1/subscription/redeem","/api/v1/maps/capabilities","/api/v1/maps/routes/","//api/v1/maps/routes",null})check(!CloudConnectionPolicy.mapsRequestIdentity("idempotency-key","request_1",path,"POST"),"identity route refused "+path);
  for(String value:new String[]{"","bad id","query=location","line\r\nbreak",null,"x".repeat(129)})check(!CloudConnectionPolicy.mapsRequestIdentity("idempotency-key",value,"/api/v1/maps/routes","POST"),"invalid Maps identity");
  check(!CloudConnectionPolicy.mapsRequestIdentity("idempotency-key","request_1","/api/v1/maps/routes","GET"),"read does not carry request identity");
  check(!CloudConnectionPolicy.mapsRequestIdentity("authorization","request_1","/api/v1/maps/routes","POST"),"identity rule cannot admit credentials");
  check(revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,false),"production self-revocation");
  check(revoke("https","api.eliza.app",443,"/api/v1/api-keys/current",null,"DELETE",false,false),"explicit default port");
  check(!revoke("https","api-staging.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,false),"staging needs test mocks");
  check(revoke("https","api-staging.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,true),"staging with test mocks");
  // DELETE is admitted for this one credential route only.
  check(!revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",true,false),"no body");
  check(!revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current","all=1","DELETE",false,false),"no query");
  check(!revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current","","DELETE",false,false),"no empty query");
  check(!revoke("http","api.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,true),"HTTPS only");
  check(!revoke("https","api.eliza.app",8443,"/api/v1/api-keys/current",null,"DELETE",false,false),"default port only");
  for(String host:new String[]{"agent.example.test","api.eliza.app.example.test","evil-api.eliza.app","cloud.eliza.app","API.ELIZA.APP",null})check(!revoke("https",host,-1,"/api/v1/api-keys/current",null,"DELETE",false,true),"host "+host);
  for(String path:new String[]{"/api/v1/api-keys","/api/v1/api-keys/","/api/v1/api-keys/current/","/api/v1/api-keys/other","/api/v1/api-keys/%63urrent","/api/v1/api-keys/current/../other","/api/v1/user","/api/conversations/1",null})check(!revoke("https","api.eliza.app",-1,path,null,"DELETE",false,true),"path "+path);
  for(String method:new String[]{"GET","POST","PUT","PATCH","delete",null})check(!revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current",null,method,false,true),"method "+method);
  // Flag-off builds contact only the fixed Cloud authority; a remote agent origin is refused from the URL alone.
  String agent="0f8fad5b-d9cb-469f-a165-70867728950e";
  for(String host:new String[]{"api.eliza.app"}){
   check(ROUTES.admittedOrigin("https",host,-1,false),"flag-off admits "+host);
   check(ROUTES.admittedOrigin("https",host,443,false),"flag-off admits the explicit default port of "+host);
   check(!ROUTES.admittedOrigin("http",host,-1,false),"flag-off HTTPS only for "+host);
   check(!ROUTES.admittedOrigin("https",host,8443,false),"flag-off default port only for "+host);
   check(!ROUTES.admittedOrigin(null,host,-1,false),"flag-off needs a scheme for "+host);
  }
  for(String host:new String[]{
   // A paired remote or development agent, and other public hosts.
   // Production Android connects no Cloud agent, so a dedicated agent runtime host is refused like any other.
   agent+".cloud.eliza.app",agent+".api.eliza.app","api.eliza.app:443","api.eliza.app@evil.example","evil.example#api.eliza.app","xn--pi-7ka.eliza.app","[2606:4700::1]",
   "agent.example.test","my-agent.example","192.168.1.20","10.0.2.2","127.0.0.1","localhost","[::1]","example.com",
   // The staging authority exists only in test-mocks builds.
   "api-staging.eliza.app",agent+".cloud-staging.eliza.app",
   // Lookalikes, other Eliza hosts and spellings the renderer never produces.
   "eliza.app","www.eliza.app","cloud.eliza.app","evil.cloud.eliza.app","evil-api.eliza.app","xapi.eliza.app","api.eliza.app.example.test","api.eliza.app.",
   "API.ELIZA.APP","api.eliza.app\n","api.eliza.app\u200b","api.eliza.app%00","sub.api.eliza.app",
   agent+".cloud.eliza.app.example.test",agent+".cloud.eliza.app.",agent.toUpperCase(java.util.Locale.ROOT)+".cloud.eliza.app","x"+agent+".cloud.eliza.app",
   agent+".evil.cloud.eliza.app","a."+agent+".cloud.eliza.app",agent+"xcloud.eliza.app",agent+".cloud.eliza.app\n","0f8fad5b-d9cb-069f-a165-70867728950e.cloud.eliza.app",
   "0f8fad5bd9cb469fa16570867728950e.cloud.eliza.app","",null})
   check(!ROUTES.admittedOrigin("https",host,-1,false),"flag-off refuses "+host);
  // Test-mocks builds are unchanged: every origin the URL validation admits still reaches the transport.
  for(String host:new String[]{"agent.example.test","api-staging.eliza.app","api.eliza.app",agent+".cloud.eliza.app"})check(ROUTES.admittedOrigin("https",host,-1,true),"test mocks keep "+host);
  check(!ROUTES.admittedOrigin("https",agent+".cloud.eliza.app",443,false),"flag-off refuses the agent runtime on its explicit port");
  // What java.net.URI hands the guard for spellings that try to smuggle another authority.
  for(String text:new String[]{"https://api.eliza.app@evil.example/api/v1/user","https://api.eliza.app:443@evil.example/","https://api.eliza.app.evil.example/","https://API.ELIZA.APP/","https://api.eliza.app./",
   "https://api.eliza.app%2eevil.example/","https://[::1]/","https://api.eliza.app:8443/","http://api.eliza.app/","https://evil.example/?https://api.eliza.app/","https://evil.example/api.eliza.app","https://api\u3002eliza\u3002app/"}){
   java.net.URI url;try{url=new java.net.URI(text);}catch(java.net.URISyntaxException error){continue;}
   check(!ROUTES.admittedOrigin(url.getScheme(),url.getHost(),url.getPort(),false),"flag-off refuses "+text);
  }
  java.net.URI plain=java.net.URI.create("https://api.eliza.app/api/v1/user?x=1");
  check(ROUTES.admittedOrigin(plain.getScheme(),plain.getHost(),plain.getPort(),false),"flag-off admits the parsed Cloud API URL");
  check(ROUTES.admittedOrigin("https","agent.example.test",8443,true),"test mocks keep a remote agent port");
  check(ROUTES.admittedOrigin("http","10.0.2.2",2138,true),"test mocks keep the development agent");

  // openExternal: a flag-off build opens Cloud sign-in, top-up and account management, and Google consent only.
  for(String text:new String[]{"https://eliza.app/auth/cli-login?session=abc","https://cloud.eliza.app/cloud/billing","https://accounts.google.com/o/oauth2/v2/auth?client_id=x","https://ELIZA.APP/auth/cli-login","https://cloud.eliza.app:443/cloud/billing"}){
   java.net.URI url=java.net.URI.create(text);
   check(ROUTES.externalHost(url.getScheme(),url.getHost(),url.getPort(),false),"flag-off opens "+text);
   check(ROUTES.externalHost(url.getScheme(),url.getHost(),url.getPort(),true),"test mocks open "+text);
  }
  for(String host:new String[]{"staging.eliza.app","cloud-staging.eliza.app","www.eliza.app","api.eliza.app","evil.eliza.app",agent+".cloud.eliza.app","a.b.eliza.app",
   "eliza.app.","cloud.eliza.app.","eliza.app.evil.example","evil-eliza.app","xeliza.app","accounts.google.com.evil.example","mail.google.com","google.com","example.com","",null})
   check(!ROUTES.externalHost("https",host,-1,false),"flag-off refuses to open "+host);
  for(String host:new String[]{"staging.eliza.app","cloud-staging.eliza.app"})check(ROUTES.externalHost("https",host,-1,true),"test mocks open "+host);
  for(String host:new String[]{"www.eliza.app",agent+".cloud.eliza.app",".eliza.app","eliza.app.evil.example","evil-eliza.app","a..eliza.app","eliza.app.","evil.example",null})check(!ROUTES.externalHost("https",host,-1,true),"test mocks still refuse "+host);
  check(!ROUTES.externalHost("http","eliza.app",-1,true),"openExternal is HTTPS only");
  check(!ROUTES.externalHost("https","eliza.app",8443,true),"openExternal uses the default port only");
  check(!ROUTES.externalHost(null,"eliza.app",-1,false),"openExternal needs a scheme");
  check(ROUTES.externalCliLogin("eliza.app","/auth/cli-login",false),"production sign-in is a browser handoff");
  check(!ROUTES.externalCliLogin("staging.eliza.app","/auth/cli-login",false),"staging sign-in needs test mocks");
  check(ROUTES.externalCliLogin("staging.eliza.app","/auth/cli-login",true),"staging sign-in with test mocks");
  check(!ROUTES.externalCliLogin("cloud.eliza.app","/auth/cli-login",true),"only the web authority hosts sign-in");
  check(!ROUTES.externalCliLogin("eliza.app","/auth/cli-login/",false)&&!ROUTES.externalCliLogin("eliza.app","/cloud/billing",false)&&!ROUTES.externalCliLogin(null,"/auth/cli-login",true),"exact sign-in path only");
  for(String route:new String[]{"/api/v1/eliza/agents","/api/v1/eliza/agents/id/api/conversations","/api/auth/pair","/api/conversations","/api/v1/eliza/personal","/api/v1/eliza/google/../agents","/api/v1/%65liza/google/status","/api/v1/eliza/google/status/","/api/v1/eliza/google//status"})for(String method:new String[]{"GET","POST"})check(!ROUTES.managedService(route,null,method,false,false),"hosted/unreviewed path refused "+route);
  check(ROUTES.managedService("/api/v1/user",null,"GET",false,false),"owner identity allowed");
  for(String path:new String[]{"/api/v1/eliza/google/calendar/calendars","/api/v1/eliza/google/calendar/feed"}){
   check(ROUTES.managedService(path,"grantId=owned","GET",false,false),"owner Google Calendar read allowed");
   for(String method:new String[]{"POST","DELETE","PUT","PATCH"})check(!ROUTES.managedService(path,null,method,true,false),"Google Calendar mutation refused");
   check(!ROUTES.managedService(path,null,"GET",true,false),"Google Calendar GET body refused");
   check(!ROUTES.managedService(path+"/",null,"GET",false,false),"Google Calendar trailing slash refused");
  }
  String sync="/api/v1/eliza/google/calendar/sync-v1/event";
  for(String method:new String[]{"POST","PATCH"}){
   check(ROUTES.managedService(sync,null,method,true,false),"versioned sync write allowed");
   check(!ROUTES.managedService(sync,"grantId=owned",method,true,false),"sync writes forbid query");
   check(!ROUTES.managedService(sync,null,method,false,false),"sync writes need body");
  }
  for(String method:new String[]{"GET","DELETE"}){
   check(ROUTES.managedService(sync,"grantId=owned",method,false,false),"versioned sync query allowed");
   check(!ROUTES.managedService(sync,null,method,false,false),"sync needs query");
   check(!ROUTES.managedService(sync,"grantId=owned",method,true,false),"sync query forbids body");
  }
  check(!ROUTES.managedService(sync+"/",null,"PATCH",true,false),"sync slash refused");
  check(!ROUTES.managedService(sync,null,"PUT",true,false),"sync PUT refused");
  check(!ROUTES.managedService("/api/v1/eliza/google/calendar/events",null,"GET",false,false),"unreviewed Google Calendar route refused");
  // Subscription plan gate (#410): code redemption is one POST with a body; the billing snapshot is read-only; credits are retired.
  check(ROUTES.managedService("/api/v1/subscription/redeem",null,"POST",true,false),"subscription code redemption allowed");
  check(!ROUTES.managedService("/api/v1/subscription/redeem",null,"POST",false,false),"redemption needs a body");
  check(!ROUTES.managedService("/api/v1/subscription/redeem","code=x","POST",true,false),"redemption never carries a query");
  check(!ROUTES.managedService("/api/v1/subscription/redeem",null,"GET",false,false),"redemption is POST only");
  check(!ROUTES.managedService("/api/v1/subscription/redeem/",null,"POST",true,false)&&!ROUTES.managedService("/api/v1/subscription/redeem/x",null,"POST",true,false),"neighbouring redemption paths refused");
  check(ROUTES.managedService("/api/v1/billing/limits",null,"GET",false,false),"billing snapshot read allowed");
  check(!ROUTES.managedService("/api/v1/billing/limits",null,"POST",true,false),"billing snapshot write refused");
  check(!ROUTES.managedService("/api/v1/credits/balance",null,"GET",false,false),"credit balance retired");
  // Reset Alpha data revokes only the presented key through the shared CloudKeyRevocation (tested with
  // the sign-in library upstream); this transport admits exactly the same self-revocation DELETE.
  check(revoke("https","api.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,false),"production self-revocation target");
  check(revoke("https","api-staging.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,true),"staging self-revocation target in test-mocks builds");
  check(!revoke("https","api-staging.eliza.app",-1,"/api/v1/api-keys/current",null,"DELETE",false,false),"flag-off reset never targets staging");
  check(ROUTES.managedService("/api/v1/subscription/entitlement",null,"GET",false,false)&&ROUTES.managedService("/api/v1/subscription/entitlement-keys",null,"GET",false,false),"subscription entitlement reads allowed");
  check(!ROUTES.managedService("/api/v1/subscription/entitlement",null,"POST",true,false)&&!ROUTES.managedService("/api/v1/subscription/checkout",null,"GET",false,false),"subscription writes and other subscription paths refused");
  check(ROUTES.managedService("/api/v1/eliza/google/gmail/inbox-v1/thread","grantId=owned", "GET",false,false),"owner Gmail route allowed");
  check(ROUTES.managedService("/api/v1/eliza/google/gmail/inbox-v1/operations/owned-id/dispatch",null,"POST",true,false),"reviewed Gmail dispatch allowed");
  check(!ROUTES.managedService("/api/v1/user",null,"POST",true,false),"identity write refused");
  check(!ROUTES.managedService("/api/v1/user",null,"GET",true,false),"GET body refused");
  check(ROUTES.managedService("/api/agents",null,"GET",false,true),"separate development infrastructure retained");
  // Eliza Cloud Maps (#412): exact routes; location only in a POST body, capabilities a bare GET.
  check(ROUTES.managedService("/api/v1/maps/capabilities",null,"GET",false,false),"Maps capabilities read allowed");
  for(String route:new String[]{"geocode","reverse","places/search","places/details","routes"}){
   String path="/api/v1/maps/"+route;
   check(ROUTES.managedService(path,null,"POST",true,false),"Maps "+route+" allowed");
   check(!ROUTES.managedService(path,null,"POST",false,false),"Maps "+route+" needs a body");
   check(!ROUTES.managedService(path,"lat=1","POST",true,false),"Maps "+route+" never carries a query");
   check(!ROUTES.managedService(path,"q=x","GET",false,false),"Maps "+route+" is POST only");
   check(!ROUTES.managedService(path+"/",null,"POST",true,false),"Maps "+route+" trailing slash refused");
  }
  check(!ROUTES.managedService("/api/v1/maps/capabilities","region=x","GET",false,false),"Maps capabilities query refused");
  check(!ROUTES.managedService("/api/v1/maps/capabilities",null,"POST",true,false),"Maps capabilities write refused");
  for(String path:new String[]{"/api/v1/maps","/api/v1/maps/tiles/1/2/3","/api/v1/maps/places","/api/v1/maps/navigation","/api/v1/maps/%72outes","/api/v1/maps//routes"})for(String method:new String[]{"GET","POST"})check(!ROUTES.managedService(path,null,method,"POST".equals(method),false),"unreviewed Maps path refused "+path);
  // Canonical spelling and the sign-in poll the transport holds until the app is foreground.
  check("/api/auth/pair".equals(CloudConnectionPolicy.canonical("//api//auth/pair//"))&&"".equals(CloudConnectionPolicy.canonical(null))&&"/".equals(CloudConnectionPolicy.canonical("///")),"canonical path");
  check(ROUTES.cliSessionPoll("api.eliza.app","/api/auth/cli-session/0f8fad5b-d9cb-469f-a165-70867728950e","GET"),"production sign-in poll");
  check(ROUTES.cliSessionPoll("api-staging.eliza.app","/api/auth/cli-session/0f8fad5b-d9cb-469f-a165-70867728950e","GET"),"staging sign-in poll");
  check(!ROUTES.cliSessionPoll("api.eliza.app","/api/auth/cli-session/0f8fad5b-d9cb-469f-a165-70867728950e","POST")&&!ROUTES.cliSessionPoll("evil.example","/api/auth/cli-session/0f8fad5b-d9cb-469f-a165-70867728950e","GET")&&!ROUTES.cliSessionPoll("api.eliza.app","/api/auth/cli-session",  "GET"),"other requests are not the poll");
  // Injected hosts: another deployment admits only its own authority.
  CloudConnectionPolicy other=new CloudConnectionPolicy(new CloudConnectionPolicy.Hosts("api.example.test","api-staging.example.test","example.test","staging.example.test","cloud.example.test","cloud-staging.example.test",Set.of()));
  check(other.admittedOrigin("https","api.example.test",-1,false)&&!other.admittedOrigin("https","api.eliza.app",-1,false),"origin follows injected hosts");
  check(!other.externalHost("https","accounts.google.com",-1,false)&&other.externalHost("https","cloud.example.test",-1,false),"external providers are injected");
  System.out.println("PASS cloud connection policy: retired pairing, exact Cloud self-revocation, the flag-off Cloud API origin, managed-service routes (Maps included) and openExternal hosts");
 }
}
