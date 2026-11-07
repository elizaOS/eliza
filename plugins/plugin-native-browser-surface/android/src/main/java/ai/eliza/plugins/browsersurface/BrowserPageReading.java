package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Page reading policy for a browser host that reads a public page aloud or hands an excerpt to a
 * question review (for example "Ask about page"). The host runs {@link #EXTRACT} only in an
 * isolated JavaScript world of the selected tab's main frame, after {@link #sensitiveUrl} refused
 * nothing; a host without isolated-world support offers no page reading at all and never runs the
 * script in the page's own world.
 *
 * <p>This is a conservative local heuristic, not a credential detector or a proof that arbitrary web
 * content is safe. False positives deliberately require opening a different page; there is no
 * bypass that sends a blocked document. The renderer half ({@code ./page-reading}) applies the same
 * rules to pasted or edited text. Pure JVM; no Android types.
 */
public final class BrowserPageReading {
  private BrowserPageReading() {}

  /** Reject codes, so a renderer never parses message text. */
  public static final String READING_UNSUPPORTED = "reading-unsupported";
  public static final String READING_NOT_READY = "reading-not-ready";
  public static final String ISOLATED_WORLD_UNAVAILABLE = "isolated-world-unavailable";
  public static final String SENSITIVE_PAGE = "sensitive-page";
  /** Shown when the WebView provider has no isolated script world; the renderer says the same. */
  public static final String UNSUPPORTED_MESSAGE =
      "Read aloud and Ask about page are unavailable on this device: its Android System WebView cannot read a page privately. Update Android System WebView.";
  /** The longest excerpt {@link #EXTRACT} returns. */
  public static final int MAX_EXCERPT = 5000;

  private static final String[] PASSWORD_SERVICES = {"pass.proton.me", "account.proton.me",
      "accounts.google.com", "passwords.google.com", "bitwarden.com", "bitwarden.eu",
      "1password.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "nordpass.com",
      "passbolt.com"};
  private static final Pattern SENSITIVE_ROUTE = Pattern.compile(
      "(?:^|[^a-z0-9])(?:api[\\s_-]*key|vault|passwords?|passphrase|signin|sign-in|login|log-in|logout|auth|oauth|sso|account|accounts|security|mfa|2fa|otp|recovery|reset-password|credentials?|access_token|id_token|refresh_token|secret|token)(?:$|[^a-z0-9])");

  /**
   * True when reading must be refused before any extraction: not an HTTPS page without user
   * info, a password service, or an address whose decoded route names sign-in, account,
   * recovery, token or similar material. Anything unparseable is sensitive.
   */
  public static boolean sensitiveUrl(String value) {
    try {
      if (value == null || value.length() > 8192)
        return true;
      URI uri = new URI(value);
      String host = uri.getHost();
      if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null)
        return true;
      host = host.toLowerCase(Locale.ROOT);
      if (host.endsWith("."))
        host = host.substring(0, host.length() - 1);
      for (String service : PASSWORD_SERVICES)
        if (host.equals(service) || host.endsWith("." + service))
          return true;
      String route = URLDecoder.decode(value, "UTF-8").toLowerCase(Locale.ROOT);
      return SENSITIVE_ROUTE.matcher(route).find();
    } catch (Exception error) {
      return true;
    }
  }

  /**
   * The extraction script: a fixed traversal that first scans the whole document for credential
   * prose, fields and unlabelled short codes and returns {@code {blocked:true}} for any, then
   * returns at most {@link #MAX_EXCERPT} characters of visible article text as {@code
   * {text,truncated}}, or null for a document type it does not read. It reads no input values,
   * cookies, storage, form data or frame documents.
   */
  public static final String EXTRACT = """
    (()=>{
    if(!['text/html','application/xhtml+xml','text/plain'].includes(document.contentType))return null;
    // Scan the whole document before selecting an article: a vault/OTP sidebar
    // must not be omitted by choosing a harmless-looking main element.
    const deny=()=>({blocked:true});
    const sensitive=/(?:api[\\s_-]*key|access[\\s_-]*token|refresh[\\s_-]*token|password|passphrase|passcode|credential|vault|one[\\s-]*time[\\s-]*(?:password|code)|verification[\\s-]*code|security[\\s-]*code|authentication[\\s-]*code|recovery[\\s-]*(?:code|key|phrase)|backup[\\s-]*(?:code|key)|seed[\\s-]*phrase|secret[\\s-]*key|private[\\s-]*key|authenticator|two[\\s-]*factor|multi[\\s-]*factor|sign[\\s-]*in|log[\\s-]*in|\\botp\\b|\\bmfa\\b|\\b2fa\\b)/i;
    const normalize=value=>value.normalize('NFKC').replace(/[\\u200B-\\u200D\\uFEFF]/g,'');
    const pending=[document.documentElement];let inspected=0,characters=0,scanText='';
    while(pending.length){
     if(++inspected>12000)return deny();const n=pending.pop();if(!n)return deny();
     if(n.nodeType===1){
      if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(n.tagName))continue;
      for(const attr of ['type','autocomplete','id','name','class','aria-label','title','placeholder']){
       const value=n.getAttribute(attr)||'';characters+=value.length;
       if(value.length>1024||characters>65536||sensitive.test(normalize(value)))return deny();
      }
      if(n.childNodes.length+pending.length>12000)return deny();
      for(let i=n.childNodes.length-1;i>=0;i--)pending.push(n.childNodes[i]);
     }else if(n.nodeType===3){
      // No input values, cookies, storage, form data or frame documents are read.
      const value=n.nodeValue||'';characters+=value.length;
      if(value.length>20000||characters>65536)return deny();
      scanText+=' '+normalize(value);
     }
    }
    // Unlabelled short authentication-like numbers are ambiguous. Reject rather
    // than assuming that a visible code is harmless prose. Years remain usable.
    if(sensitive.test(scanText))return deny();
    if(/(?:^|\\D)\\d{6,8}(?:\\D|$)/.test(scanText))return deny();

    const blocked='script,style,noscript,template,form,input,textarea,select,option,button,iframe,frame,object,embed,nav,header,footer,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[role="navigation"],[role="textbox"],[role="button"]';
    const visible=e=>{const s=getComputedStyle(e);return !e.matches(blocked)&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)!==0&&s.contentVisibility!=='hidden'&&s.clip==='auto'&&s.clipPath==='none'&&Array.from(e.getClientRects()).some(r=>r.width>1&&r.height>1);};
    let root=document.querySelector('article,main,[role="main"]')||document.body;
    if(!root)return null;let a=root,depth=0;while(a){if(++depth>128||!visible(a))return null;a=a.parentElement;}
    const stack=[root];let text='',count=0,truncated=false;
    while(stack.length){if(++count>12000){truncated=true;break;}const n=stack.pop();
    if(n.nodeType===1){if(!visible(n))continue;const children=n.childNodes;if(children.length+stack.length>12000){truncated=true;break;}for(let i=children.length-1;i>=0;i--)stack.push(children[i]);}
    else if(n.nodeType===3){const raw=n.nodeValue||'';if(raw.length>20000)truncated=true;const value=raw.slice(0,20000).replace(/\\s+/g,' ').trim();if(value){const next=(text?'\\n':'')+value;const remaining=5000-text.length;text+=next.slice(0,remaining);if(next.length>remaining){truncated=true;break;}}}
    }
    if(text.length&&/[\\uD800-\\uDBFF]$/.test(text))text=text.slice(0,-1);
    return {text,truncated};
    })()
    """;
}
