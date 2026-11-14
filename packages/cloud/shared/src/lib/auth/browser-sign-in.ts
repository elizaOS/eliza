const proof = /^[A-Za-z0-9_-]{43}$/;
const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{3,4}$/;
const lifetime = 10 * 60 * 1000;

/** Protected deployment data, never fields supplied by the launch request. */
export interface BrowserSignInConfiguration {
  startPath: string;
  returnPath: string;
  storageKey: string;
  apiOrigin: string;
  tenant: string;
}

/** Pages sees the initiating browser's Origin on the form POST. Never accept a return URL from the form. */
export async function browserSignInStart(
  request: Request,
  callback: URL,
  configuration: BrowserSignInConfiguration,
): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  if (request.method === "GET") return Response.json({ version: 1 }, { headers: noStore });
  const origin = request.headers.get("Origin") ?? "";
  const port = Number(origin.slice(origin.lastIndexOf(":") + 1));
  if (
    request.method !== "POST" ||
    !loopback.test(origin) ||
    port < 1024 ||
    port > 65535 ||
    request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded"
  )
    return new Response("Invalid browser sign-in launch", {
      status: 400,
      headers: noStore,
    });

  const reader = request.body?.getReader();
  if (!reader)
    return new Response("Missing browser sign-in request", {
      status: 400,
      headers: noStore,
    });
  const decoder = new TextDecoder();
  let body = "",
    size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256) {
      await reader.cancel();
      return new Response("Invalid browser sign-in request", {
        status: 400,
        headers: noStore,
      });
    }
    body += decoder.decode(value, { stream: true });
  }
  const params = new URLSearchParams(body + decoder.decode());
  const state = params.get("state") ?? "",
    challenge = params.get("challenge") ?? "";
  if (params.size !== 2 || !proof.test(state) || !proof.test(challenge))
    return new Response("Invalid browser sign-in proof", {
      status: 400,
      headers: noStore,
    });

  const authorize = new URL("/steward/auth/oauth/google/authorize", configuration.apiOrigin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    tenant_id: configuration.tenant,
    redirect_uri: callback.href,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
    mfa: "exchange",
  }).toString();
  // Only validated, canonical ASCII values enter the script. No credential is stored here.
  const pending = JSON.stringify({
    origin,
    state,
    redirectUri: callback.href,
    expiresAt: Date.now() + lifetime,
  });
  const script = `try{sessionStorage.setItem(${JSON.stringify(configuration.storageKey)},${JSON.stringify(pending)});location.replace(${JSON.stringify(authorize.href)});}catch{}`;
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue sign-in</title></head><body><script nonce="${nonce}">${script}</script></body></html>`,
    {
      headers: {
        ...noStore,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

// A registered HTTPS callback may return to the exact loopback origin only in
// the top-level tab that started this attempt. PKCE still gates the code exchange.
export function browserReturnScript(
  redirectUri: string,
  configuration: BrowserSignInConfiguration,
): string {
  return `(function(){
  try {
    const pending=JSON.parse(sessionStorage.getItem(${JSON.stringify(configuration.storageKey)})||"null");
    if(!pending || pending.redirectUri!==${JSON.stringify(redirectUri)} || !${loopback}.test(pending.origin) || !Number.isSafeInteger(pending.expiresAt) || pending.expiresAt<=Date.now())return;
    const port=Number(new URL(pending.origin).port);if(port<1024||port>65535)return;
    const fragment=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search);
    const fields=fragment.size?fragment:query,state=fields.get("state");
    if(fields.size!==2||state!==pending.state||!${proof}.test(state))return;
    const code=fragment.size&&!query.size?fields.get("code"):null,error=fields.get("error");
    if(!(code&&/^[A-Za-z0-9._~-]{1,4096}$/.test(code))&&!(error&&/^[a-z_]{1,64}$/.test(error)))return;
    sessionStorage.removeItem(${JSON.stringify(configuration.storageKey)});
    history.replaceState(null,"",location.pathname);
    document.documentElement.hidden=true;
    const destination=new URL(${JSON.stringify(configuration.returnPath)},pending.origin);
    destination.hash=new URLSearchParams(code?{state,code}:{state,error}).toString();
    location.replace(destination.href);
  } catch {}
})();`;
}
