// spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for"; spec/os/browser/pageCommands.md, "An observation belongs to the live binding it was read under, and a read or an input holds none"
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Schema } from "effect";
import { chromium, type Browser, type CDPSession, type Locator, type Page, type Request } from "playwright";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCommandHandler } from "../browser/src/command-handler.mjs";
import { nativeControlProgram } from "./drivers/os__browser__pageCommands.ts";

const shop = "https://shop.example";
const partner = "https://pay.example";
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const fields = Schema.decodeUnknownSync(Fields);
const text = Schema.decodeUnknownSync(Schema.String);
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const source = (file: string, name: string) =>
  text(runInNewContext(`${readFileSync(new URL(`../browser/src/${file}`, import.meta.url), "utf8").replace(/^export /gm, "")}\n${name}.toString()`));
const pageCommand = source("page-command.mjs", "pageCommand");
const embedded = (file: string, name: string, contents = readFileSync(new URL(file, import.meta.url), "utf8")) => {
  const parsed = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const find = (node: ts.Node): ts.FunctionDeclaration | ts.FunctionExpression | undefined =>
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name ? node : ts.forEachChild(node, find);
  const found = find(parsed);
  if (!found?.body) throw new Error(`${name} is not in ${file}`);
  const tokens = (node: ts.Node): string[] =>
    node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode ? [] : node.getChildCount(parsed) === 0 ? [node.getText(parsed)] : node.getChildren(parsed).flatMap(tokens);
  const all = [...found.parameters.flatMap(tokens), "|", ...tokens(found.body)];
  return { text: found.getText(parsed), tokens: all.filter((token, index) => token !== "," || ![")", "]", "}"].includes(all[index + 1] ?? "")) };
};
const channel = nativeControlProgram();
const pageGuidance = source("page-guidance.mjs", "pageGuidance");
const Read = Schema.Struct({ complete: Schema.Literal(true), text: Schema.String, elements: Schema.Array(Fields) });
const Box = Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number });
type Fields = typeof Fields.Type;
interface Snapshot { readonly id: string; readonly value: Fields; readonly elements: readonly Fields[]; readonly text: string }

const pressed = `<script>window.top.pressed ??= [];document.addEventListener("click", (event) => {const control = event.composedPath().find((node) => node.matches?.("button,a,input"));if (control) window.top.pressed.push(control.id);}, true);</script>`;
const page = (body: string) =>
  `<!doctype html><html lang="en"><style>body{font:18px system-ui;margin:16px}label,button,input{display:block;margin:6px 0}</style>${body}${pressed}</html>`;
const cardForm = (words: string, money = "<p>Total $84.20</p>") =>
  page(`<form action="/paid" method="get"><label>Card number <input id="card" autocomplete="cc-number"></label><label>Security code <input id="cvc"></label><button type="button" id="details">Show details</button><button id="frame-pay">Pay now</button></form>${money}<p>${words}</p>`);
const codes = "https://codes.example";
const secure = "https://secure.codes.example";
const bank = "https://bank.example";
const field = `<script>customElements.define("bank-field", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<label for="input">' + this.getAttribute("label") + '</label><input id="input" name="' + this.id + '" type="' + (this.getAttribute("type") ?? "text") + '">'; } });</script>`;
const logon = (frame: string) =>
  page(`<h1>Sign in</h1><iframe name="logonbox" title="logon" src="${frame}?fromOrigin=${secure}" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0"></iframe><iframe title="empty" src="/empty" style="position:absolute;left:0;top:-5000px;width:0;height:0;border:0"></iframe>`);
const digits = (prefix: string, count: number, from = 1, extra = (_: number) => "") =>
  Array.from({ length: count }, (_, index) => `<input id="${prefix}${from + index}" aria-label="Digit ${from + index}" maxlength="1" inputmode="numeric"${extra(from + index)}>`).join("");
const moveOn = (form: string) =>
  `<script>const boxes=[...document.querySelectorAll('#${form} input')];boxes.forEach((box,i)=>box.addEventListener('input',()=>{if(box.value.length===1&&boxes[i+1])boxes[i+1].focus()}));</script>`;
const accountInvitation = (publicContent: string, attributes = "", extra = "", prompt = "Sign in to view and pay your bill.") =>
  page(`<main><section ${attributes} style="height:55vh"><p>${prompt}</p><a href="/signin">Sign in</a>${extra}</section>${publicContent}</main>`);
const publicPanel = (attributes = "") => `<section ${attributes}><h2>Public information</h2><a href="/help">Help center</a></section>`;
const pages: Record<string, string> = {
  [`${shop}/signin`]: page(`<h1>Welcome back</h1><northfield-login></northfield-login><sealed-box></sealed-box><script>
    customElements.define("northfield-login", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<form><label>Username <input id="shadow-user" name="username"></label><label>Password <input id="shadow-pass" type="password"></label><button type="button" id="shadow-next">Next</button><p id="echo"></p></form>'; } });
    customElements.define("sealed-box", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "closed" }).innerHTML = '<label>Closed field <input id="closed-field"></label><button type="button" id="closed-button">Closed button</button><p>Sealed words</p>'; } });
  </script>`),
  [`${shop}/statement-regions`]: page(`<nav>Navigation date</nav><main><p>Unrelated date</p><article><h1>Current statement</h1><p>Amount due: <strong>$64.28</strong> by <time>October 12, 2026</time></p><dl><dt>Reference</dt><dd>Current account</dd></dl><section><h2>Previous period</h2><p>Prior amount $11</p></section><span hidden>Hidden date</span><span style="opacity:0">Invisible date</span><form><button type="button">Form date</button></form></article><iframe src="/statement-frame" title="Statement frame"></iframe><iframe src="${partner}/statement-frame" title="Third-party statement frame"></iframe></main>`),
  [`${shop}/statement-headings`]: page(`<main><header><h1>Account overview</h1></header><h1 hidden>Hidden heading</h1><div id="paid-title">Paid statement <span role="link" tabindex="0">View activity</span></div><section aria-labelledby="paid-title"><header><h2>Previous bill</h2></header><section><h3>Details</h3><p>Amount due: $12</p><p>Due date: June 3</p></section></section><section><a style="display:block" href="/archives">Previous statements</a><p>Amount due: $20</p><p>Due date: June 30</p></section><section><h2>Current invoice</h2><h2>Archived invoice</h2><p>Amount due: $30</p><p>Due date: July 3</p></section><section><header><div><h2>Current invoice <a href="/past">Past invoice link</a> <span role="button" tabindex="0">Show archive</span></h2><p>Due August 12</p><button>Pay</button></div></header><p>Amount due: $40</p></section><header><p>Global header date</p></header></main>`),
  [`${shop}/statement-frame`]: page("<section>Same-origin frame amount</section>"),
  [`${partner}/statement-frame`]: page("<section>Cross-origin frame amount</section>"),
  [`${shop}/pay`]: page(`<h1>Make a payment</h1><p>Amount due $84.20</p><iframe id="card-frame" src="/card-frame" title="Secure payment form" style="width:520px;height:330px;border:4px solid #333;padding:6px"></iframe><iframe id="other-frame" src="${partner}/card-frame" title="Partner payment form" style="width:520px;height:330px"></iframe>`),
  [`${shop}/card-frame`]: cardForm("Card words"),
  [`${partner}/card-frame`]: cardForm("Partner words"),
  [`${shop}/framed-plain`]: page(`<h1>Newsletter</h1><iframe id="plain-frame" src="/plain-frame" title="Sign up form" style="width:520px;height:260px"></iframe>`),
  [`${shop}/plain-frame`]: page(`<label>Email <input id="email" type="email"></label><label>How often <select id="often"><option>Weekly</option><option>Monthly</option></select></label><a id="terms" href="/terms">Our terms</a><button type="button" id="details">Show details</button>`),
  [`${shop}/card-only`]: page(`<button type="button" id="top-details">Show details</button><iframe id="card-frame" src="/card-frame-plain" title="Card"></iframe>`),
  [`${shop}/card-frame-plain`]: cardForm("Card words", ""),
  [`${shop}/framed-modal`]: page(`<h1>Your account</h1><iframe id="modal-frame" src="/modal-frame" title="Account" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0"></iframe>`),
  [`${shop}/modal-frame`]: page(`<form><label>Email <input id="email" type="email"></label><button type="button" id="details">Show details</button></form><div role="dialog" aria-modal="true" aria-label="Session" style="position:fixed;left:0;top:0;right:0;bottom:0;background:#fff">Your session is about to end.<button type="button" id="stay">Close</button></div>`),
  [`${shop}/shadow-consent`]: page(`<h1>Opening hours</h1><p>Our branches open at nine.</p><consent-layer></consent-layer><script>customElements.define("consent-layer", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<div id="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;height:140px;background:#eee">We use cookies.<button type="button" id="reject">Reject all</button><button type="button" id="accept">Accept all</button></div>'; } });</script>`),
  [`${shop}/sign-on`]: page(`<h1>Online banking</h1><button type="button" id="sign-on">Sign On</button><button type="button" id="log-on">Log on</button><button type="button" id="hours">Branch hours</button>`),
  [`${shop}/scoped-invitation`]: accountInvitation(publicPanel()),
  [`${shop}/mixed-invitation`]: accountInvitation(publicPanel() + '<section><p>Please sign in to continue.</p><a href="/signin">Sign in to continue</a></section>'),
  [`${shop}/overlay-invitation`]: page(`<main>${publicPanel()}<section style="position:fixed;inset:0;background:white"><p>Sign in to view your bill.</p><a href="/signin">Sign in</a></section></main>`),
  [`${shop}/footer-only-invitation`]: accountInvitation(`<footer>${publicPanel()}</footer>`),
  [`${shop}/disabled-invitation`]: accountInvitation(publicPanel('aria-disabled="true"')),
  [`${shop}/hidden-invitation`]: accountInvitation(publicPanel('aria-hidden="true"')),
  [`${shop}/placeholder-invitation`]: accountInvitation(publicPanel().replace('href="/help"', 'href="#"')),
  [`${shop}/external-invitation`]: accountInvitation(publicPanel().replace('href="/help"', 'href="https://elsewhere.example/help"')),
  [`${shop}/inert-invitation`]: accountInvitation(publicPanel("inert")),
  [`${shop}/covered-invitation`]: accountInvitation(publicPanel('style="position:relative"').replace("</section>", '<div style="position:absolute;inset:0;background:white"></div></section>')),
  [`${shop}/password-invitation`]: accountInvitation(publicPanel(), "", '<form><label>Password <input type="password"></label></form>'),
  [`${shop}/code-invitation`]: accountInvitation(publicPanel(), "", '<label>Verification code <input autocomplete="one-time-code"></label>'),
  [`${shop}/required-invitation`]: accountInvitation(publicPanel(), "", "<p>Please sign in to continue.</p>"),
  [`${shop}/paywall-invitation`]: accountInvitation(publicPanel(), "", "", "Subscribe to read the full article."),
  [`${shop}/captcha-invitation`]: accountInvitation(publicPanel(), "", "", "Confirm you are human."),
  [`${shop}/wall`]: page(`<h1>Your statements</h1><p>Statements for the last seven years are kept here, with the notices we sent about each account and the letters about changes to its terms.</p><section><p>Please sign in to continue.</p><a href="/signin">Sign in</a></section>`),
  [`${shop}/static-dialog`]: page(`<h1>Opening hours</h1><div role="dialog" aria-label="Notice">We changed our opening hours for the holidays.<button type="button" id="close-notice">Close</button></div><p>Our branches open at nine.</p>`),
  [`${shop}/absolute-wall`]: page(`<h1>Your statements</h1><p>Statements for the last seven years are kept here, with the notices we sent about each account and the letters about changes to its terms.</p><div style="position:absolute;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.6)"><section><p>Please sign in to continue.</p><a href="/signin">Sign in</a></section></div>`),
  [`${shop}/fixed-banner`]: page(`<h1>Opening hours</h1><p>Our branches open at nine.</p><div style="position:fixed;left:0;right:0;bottom:0;height:140px;background:#eee">We use cookies to improve your visit.<button type="button" id="cookies-ok">Accept</button></div>`),
  [`${shop}/fixed-shell`]: page(`<div id="app" style="position:fixed;left:0;top:0;right:0;bottom:0;overflow:auto"><h1>Your statements</h1><p>Statements for the last seven years are kept here, with the notices we sent about each account and the letters about changes to its terms.</p><section><p>Please sign in to continue.</p><a href="/signin">Sign in</a></section></div>`),
  [`${shop}/absolute-shell`]: page(`<div id="app" style="position:absolute;left:0;top:0;width:100%;min-height:100%"><h1>Your statements</h1><p>Statements for the last seven years are kept here, with the notices we sent about each account and the letters about changes to its terms.</p><section><p>Please sign in to continue.</p><a href="/signin">Sign in</a></section></div>`),
  [`${shop}/covered`]: page(`<iframe id="plain-frame" src="/plain-frame" title="Sign up form" style="width:400px;height:200px"></iframe><p>Below the frame are our opening hours, our address and a map of the branch offices.</p><div role="dialog" aria-label="Notice" style="position:fixed;left:0;top:0;width:440px;height:240px;background:#fff">Please read this notice<button type="button" id="close-notice">Close</button></div>`),
  [`${secure}/dashboard`]: logon("/auth/"),
  [`${secure}/auth/`]: `<form id="logon" action="/auth/logon" method="post"><bank-field id="userId" label="Username"></bank-field><bank-field id="password" label="Password" type="password"></bank-field><label>Sign in with <select id="token"><option>Password</option><option>Token</option></select></label><a id="forgot" href="/auth/forgot">Forgot username or password?</a><button type="button" id="signin">Sign in</button></form>${field}`,
  [`${codes}/label`]: `<form action="/done" method="post"><label>Verification code <input id="code" name="code" inputmode="numeric"></label><label>Name <input id="name"></label><label>Enter the 6-digit code <input id="six"></label><button id="verify">Verify</button></form><form action="/a"><label>Enter code <input id="enter"></label></form><form action="/b"><label>Temporary identification code <input id="temporary"></label></form><form action="/c"><p>We emailed you a 6-digit code.</p><label>Confirmation code <input id="confirm"></label></form>`,
  [`${codes}/marked`]: `<form action="/done" method="post"><input id="marked" aria-label="Code" autocomplete="one-time-code"></form>`,
  [`${codes}/refused`]: `<form action="/a"><label>Card verification code <input id="cvv" name="cvv"></label></form><form action="/b"><label>Security code <input id="csc"></label></form><form action="/c"><label>Verification code <input id="paycode"></label><label>Card number <input id="card" autocomplete="cc-number"></label></form><form action="/d"><label>Password <input id="pw" type="password"></label><label>PIN <input id="pin"></label><label>Verification code <input id="cccode" autocomplete="cc-csc"></label></form><form action="/e"><label>Routing number <input id="routing"></label></form><form action="/f"><label>Verification code <input id="bankcode"></label><label>Bank account number <input id="acct"></label></form><form action="/g"><label>Social Security number <input id="ssn"></label></form><form action="/h"><label>Passport number <input id="passport"></label></form><form action="/i"><label>Card security code <input id="markedcvv" autocomplete="one-time-code"></label></form><form action="/j"><p>Enter the security code on the back of your card</p><input id="nearcvv" aria-label="Code" autocomplete="one-time-code"></form><form action="/k"><label>Code <input id="formcvv" autocomplete="one-time-code"></label><label>Card number <input autocomplete="cc-number"></label></form><form action="/l"><label>Promo code <input id="promo"></label></form><form action="/m"><label>Coupon code <input id="coupon"></label></form><form action="/n"><label>Referral code <input id="referral"></label></form><form action="/o"><label>ZIP code <input id="zip"></label></form><form action="/p"><label>Area code <input id="area"></label></form><form action="/q"><label>Code <input id="markedpromo" name="promo_code" autocomplete="one-time-code"></label></form>`,
  [`${codes}/paying-groups`]: `<form action="/a"><p>Enter the code we sent.</p>${digits("q", 6)}<label>Card number <input autocomplete="cc-number"></label></form><form action="/b"><p>Enter the code we sent.</p>${digits("w", 6)}<label>Bank account number <input></label></form><p>Redeem a gift code.</p><form action="/c">${digits("v", 6)}</form>`,
  [`${codes}/digits`]: `<p>Enter the 6-digit code we emailed you.</p><form id="f" action="/account" method="get">${digits("d", 6)}<button id="verify">Verify</button></form>${moveOn("f")}`,
  [`${codes}/unnamed`]: `<p>Enter the last six digits of your number.</p><form id="f" action="/account" method="get">${digits("u", 6)}</form>`,
  [`${codes}/card-digits`]: `<p>Enter the code for the last 4 of your card.</p><form id="f" action="/account" method="get">${digits("k", 4)}</form>`,
  [`${codes}/split`]: `<p>Enter the code we sent.</p><form action="/a">${digits("a", 3)}</form><form action="/b">${digits("b", 3, 4)}</form>`,
  [`${codes}/two-runs`]: `<p>Enter the code we sent.</p><form action="/a">${digits("x", 3)}<input id="mid" aria-label="Middle">${digits("y", 3, 4)}</form>`,
  [`${codes}/pin`]: `<p>Enter the code we sent.</p><form action="/a"><fieldset><legend>Enter your PIN</legend>${digits("p", 4)}</fieldset></form>`,
  [`${codes}/grouped`]: `<div role="group" aria-label="Enter the code we sent">${digits("g", 4)}</div>`,
  [`${codes}/hidden-digit`]: `<p>Enter the code we sent.</p><form action="/a">${digits("h", 6, 1, (n) => (n === 3 ? ' type="password"' : ""))}</form>`,
  [`${codes}/states`]: `<p>Enter the code we sent.</p><form action="/a">${digits("o", 6, 1, (n) => (n === 4 ? " disabled" : ""))}</form><p>Enter the code we sent.</p><form action="/b">${digits("r", 6, 1, (n) => (n === 5 ? " readonly" : ""))}</form>`,
  [`${codes}/number-digits`]: `<p>Enter the code we sent.</p><form action="/a">${digits("n", 6, 1, () => ' type="number"')}</form><form action="/b"><label>Verification code <input id="ncode" type="number"></label></form>`,
  [`${codes}/marked-digits`]: `<p>Enter the code we sent.</p><form action="/a">${digits("m", 6, 1, () => ' autocomplete="one-time-code"')}</form>`,
  [`${codes}/otp-shadow`]: `<p>Sign in</p><form id="f" action="/account"><otp-input></otp-input><button id="verify">Verify</button></form><script>customElements.define("otp-input", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<div role="group" aria-labelledby="otp-name">' + [1, 2, 3, 4, 5, 6].map((n) => '<input id="d' + n + '" aria-label="Digit ' + n + '" maxlength="1" inputmode="numeric">').join("") + '</div><span id="otp-name">Enter the code we sent</span>'; } });</script>`,
  [`${codes}/autosubmit`]: `<p>Enter the code we sent.</p><form id="f" action="/account" method="get">${digits("s", 6)}</form><script>document.getElementById('s6').addEventListener('input',e=>e.target.form.requestSubmit())</script>`,
  [`${codes}/clearing`]: `<p>Enter the code we sent.</p><form id="f" action="/account" method="get">${digits("c", 6)}</form><script>document.getElementById('c3').addEventListener('input',()=>{document.getElementById('c1').value=''})</script>`,
  [`${codes}/mask`]: `<label>Phone <input id="phone" type="tel"></label><label>Date <input id="date"></label><label>Amount <input id="amount"></label><label>Note <input id="note"></label><label>Verification code <input id="mcode"></label><label>Mobile <input id="plus" type="tel"></label><label>Home phone <input id="blanks" type="tel"></label><label>Office phone <input id="lose" type="tel"></label><label>Other phone <input id="gain" type="tel"></label><label>Extension <input id="short"></label><label>Member number <input id="long"></label><script>const masks={phone:d=>d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):d,date:d=>d.length===8?d.slice(0,2)+'/'+d.slice(2,4)+'/'+d.slice(4):d,amount:d=>d.length>2?d.slice(0,-2)+'.'+d.slice(-2):d,mcode:d=>d.length===6?d.slice(0,3)+'-'+d.slice(3):d,plus:d=>'+'+d.slice(0,1)+' ('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7),blanks:d=>'('+d.slice(0,3)+') '+(d.slice(3)+'____').slice(0,3)+'-____',lose:d=>'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6,9),gain:d=>'1 ('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6),short:d=>'('+d+')',long:d=>d.match(/.{1,4}/g).join(' ')};for(const [id,mask] of Object.entries(masks))document.getElementById(id).addEventListener('input',e=>{e.target.value=mask(e.target.value.replace(/\\D/g,''))});</script>`,
  [`${bank}/signin`]: page(`<h1>Sign in</h1><form action="https://secure.bank.example/form-path/sign-in?session=form-query" method="post"><label>User ID <input id="user" name="user"></label><button id="next">Next</button><button id="help" formaction="/form-path/help?topic=form-query" formmethod="get" formtarget="_blank">Help signing in</button><button type="button" id="tips">Show tips</button></form>`),
  [`${bank}/search`]: page(`<form action="form-path/search?form-query=1"><label>Search <input id="query" name="q"></label></form>`),
  [`${bank}/transfer`]: page(`<form action="/form-path/transfer?form-query=1" method="post"><label>Payee <input id="payee" name="payee"></label><button id="review" formaction="https://review.bank.example/form-path/review?form-query=1">Review</button><button id="send">Send</button></form>`),
  [`${bank}/base`]: page(`<base target="_blank"><form action="https://pay.bank.example/form-path/receipt?form-query=1" method="post"><label>Note <input id="note" name="note"></label><button id="send-note">Send note</button></form>`),
  [`${bank}/no-enter`]: page(`<form action="/form-path/two?form-query=1"><label>First name <input id="first" name="first"></label><label>Last name <input id="last" name="last"></label></form><form action="/form-path/off?form-query=1"><label>Account nickname <input id="nickname" name="nickname"></label><button id="off" disabled>Save</button></form><form action="https://pay.bank.example/form-path/one?form-query=1"><label>Search <input id="one" name="q"></label></form>`),
  [`${bank}/other`]: page(`<form action="javascript:void 0"><button id="script">Run script</button></form><form action="mailto:help@bank.example?subject=form-query" method="post" target="_blank"><input type="submit" id="mail" value="Write to us"></form><form action="https://pay.bank.example/form-path/receipt?form-query=1" method="post" target="receipt"><button id="receipt">Open receipt</button></form><dialog open><form method="dialog"><button id="close">Close</button></form></dialog>`),
  [`${secure}/verify`]: logon("/auth/verify"),
  [`${secure}/auth/verify`]: `<form id="verify" action="/auth/verify" method="post"><bank-field id="otp" label="One-time code"></bank-field><button type="button" id="next">Next</button></form>${field}`,
  [`${secure}/empty`]: `<title>empty</title><button type="button" id="beacon">Telemetry</button><script>document.body.style.width = "4000px";</script>`,
};


let browser: Browser;
let tab: Page;
let cdp: CDPSession;
let world: { loaderId: string; id: number } | undefined;
let sequence = 0;
const sent: Fields[] = [];
const inTab = (request: Request) => {
  try {
    return request.frame().page() === tab;
  } catch {
    return false;
  }
};

let launched: Promise<void> | undefined;
const launch = () =>
  (launched ??= (async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route(/^https:\/\/[a-z.]+\.example\//, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/form-path/")) sent.push({ origin: url.origin, method: route.request().method().toLowerCase(), newWindow: !inTab(route.request()) });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: pages[`${url.origin}${url.pathname}`] ?? page("<p>Received</p>") });
    });
    tab = await context.newPage();
    cdp = await context.newCDPSession(tab);
  })());
afterAll(async () => {
  if (launched) await browser.close();
});

const mainFrame = async () => (await cdp.send("Page.getFrameTree")).frameTree.frame;
const realm = async () => {
  const frame = await mainFrame();
  if (world?.loaderId !== frame.loaderId) {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "page-reader-test" });
    world = { loaderId: frame.loaderId, id: executionContextId };
  }
  return world.id;
};
const evaluate = async (expression: string, contextId?: number): Promise<unknown> => {
  const result = await cdp.send("Runtime.evaluate", { contextId: contextId ?? (await realm()), expression, returnByValue: true, awaitPromise: true });
  expect(result.exceptionDetails).toBeUndefined();
  return result.result.value;
};
interface FrameTree { readonly frame: { readonly id: string; readonly loaderId: string }; readonly childFrames?: readonly FrameTree[] }
const frameList = async () => {
  const flat = (tree: FrameTree): FrameTree[] => [tree, ...(tree.childFrames ?? []).flatMap(flat)];
  return flat((await cdp.send("Page.getFrameTree")).frameTree).map(({ frame }, frameId) => ({
    frameId,
    documentId: frame.loaderId,
    contextId: async () => frameId === 0 ? realm() : (await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "page-reader-test" })).executionContextId,
  }));
};
const surface = async () => {
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: (await mainFrame()).id, worldName: `eliza-surface-control-${++sequence}` });
  await evaluate("globalThis.elizaSurfaceControl = { replies: [], postMessage(value) { this.replies.push(JSON.parse(value)); } }", executionContextId);
  await evaluate(channel, executionContextId);
  const documentId = text(fields(await evaluate("elizaSurfaceControl.replies.find((reply) => reply.ready)", executionContextId)).documentId);
  let count = 0;
  return async (command: Fields, claimedDocument = documentId) => {
    const number = ++count;
    await evaluate(`elizaSurfaceControl.onmessage({ data: ${JSON.stringify(JSON.stringify({ documentId: claimedDocument, sequence: number, command }))} })`, executionContextId);
    await expect.poll(() => evaluate(`elizaSurfaceControl.replies.some((reply) => reply.sequence === ${number})`, executionContextId)).toBe(true);
    return fields(fields(await evaluate(`elizaSurfaceControl.replies.find((reply) => reply.sequence === ${number})`, executionContextId)).result);
  };
};
const call = (run: string, args: readonly unknown[]) => evaluate(`(${run})(...${JSON.stringify(args)})`);
const open = async (url: string) => {
  await launch();
  await tab.goto(url);
  await realm();
};
const snapshot = async (extra: Fields = {}): Promise<Snapshot> => {
  const id = `snapshot-${++sequence}`;
  const raw = await call(pageCommand, [{ subaction: "snapshot", ...extra }, id]);
  const read = Schema.decodeUnknownSync(Read)(raw);
  return { id, value: fields(raw), elements: read.elements, text: read.text };
};
const find = (state: Snapshot, label: string) => {
  const found = state.elements.find((element) => element.label === label);
  expect(found, `${label} in ${JSON.stringify(state.elements.map((element) => element.label))}`).toBeDefined();
  return fields(found);
};
const selectorOf = (element: Fields) => text(element.targetSelector);
const act = async (state: Snapshot, subaction: string, label: string, extra: Fields = {}) =>
  fields(await call(pageCommand, [{ subaction, snapshotId: state.id, nodeId: find(state, label).id, ...extra }, null]));
const refusal = async (state: Snapshot, subaction: string, label: string, extra: Fields = {}) =>
  fields((await act(state, subaction, label, extra)).error).kind;
const policy = (selector: string, action = "click", origin = shop) =>
  ({ origin, expiresAt: Date.now() + 60_000, targets: [{ selector, action }], expectedSelector: selector, guidanceScope: "1" });
const presses = async () => strings(await tab.evaluate("window.pressed ?? []"));
const near = async (actual: unknown, locator: Locator) => {
  const shown = Schema.decodeUnknownSync(Box)(await locator.boundingBox());
  const drawn = Schema.decodeUnknownSync(Box)(actual);
  expect(Math.max(...(["x", "y", "width", "height"] as const).map((key) => Math.abs(drawn[key] - shown[key])))).toBeLessThanOrEqual(1);
};
const guided = () => evaluate("globalThis.__elizaPageGuidanceV1?.visible === true");
const guide = async (state: Snapshot, label: string) =>
  fields(await call(pageGuidance, [{ kind: "show", id: `guide-${++sequence}`, snapshotId: state.id, nodeId: find(state, label).id, origin: shop, expiresAt: Date.now() + 30_000, text: "This is the place." }]));
const ring = () => evaluate("(() => { const r = globalThis.__elizaPageGuidanceV1.shadow.querySelector('.ring').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
const guideOn = async (url: string, label: string) => {
  await open(url);
  expect(await guide(await snapshot(), label)).toMatchObject({ accepted: true });
  await expect.poll(guided, { timeout: 5000 }).toBe(true);
};

describe('The WebView runs the page reader Chromium runs (spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for")', () => {
  it("embeds page-command.mjs and page-guidance.mjs token for token", () => {
    const same = (file: string, name: string) => JSON.stringify(embedded("control-channel.js", name, channel).tokens) === JSON.stringify(embedded(`../browser/src/${file}`, name).tokens);
    expect({ pageCommand: same("page-command.mjs", "pageCommand"), pageGuidance: same("page-guidance.mjs", "pageGuidance") }).toEqual({ pageCommand: true, pageGuidance: true });
  });

  it("observes disjoint statement regions only for an explicit local native read", async () => {
    await open(`${shop}/statement-regions`);
    const send = await surface();
    const request = { subaction: "snapshot", statementRegions: true };
    const Regions = Schema.Struct({
      complete: Schema.Boolean,
      primaryHeading: Schema.optionalKey(Schema.String),
      regions: Schema.Array(Schema.Struct({
        key: Schema.NonEmptyString, fragments: Schema.Array(Schema.String), heading: Schema.optionalKey(Schema.String),
        authorLabel: Schema.optionalKey(Schema.String), ancestorLabels: Schema.optionalKey(Schema.Array(Schema.String)),
        ambiguous: Schema.optionalKey(Schema.Literal(true)),
        tableRow: Schema.optionalKey(Schema.Struct({
          parentKey: Schema.NonEmptyString, columns: Schema.Array(Schema.NonEmptyString),
        })),
      })),
    });
    expect((await send({ subaction: "snapshot" })).statementRegions).toBeUndefined();
    expect(await send(request, "prior-document")).toMatchObject({ error: { kind: "STALE_REF" } });
    const grouped = await send(request);
    const complete = Schema.decodeUnknownSync(Regions)(grouped.statementRegions);
    expect(grouped.text).toBe("");
    expect(complete.complete).toBe(true);
    expect(complete.regions.map(({ fragments }) => fragments.map(value => value.trim()))).toEqual([
      ["Unrelated date"], ["Current statement", "Amount due: $64.28 by October 12, 2026", "Reference", "Current account"],
      ["Previous period", "Prior amount $11"],
    ]);
    expect(new Set(complete.regions.map(({ key }) => key)).size).toBe(3);
    expect((await send(request)).statementRegions).toEqual(complete);

    await tab.evaluate(() => {
      const oversized = document.createElement("section");
      oversized.textContent = "x".repeat(24_577);
      document.querySelector("main")?.append(oversized);
    });
    expect((await send(request)).statementRegions).toEqual({ complete: false, regions: [] });

    await open(`${shop}/signin`);
    const privatePage = await (await surface())(request);
    expect({ text: privatePage.text, regions: privatePage.statementRegions }).toEqual({
      text: "", regions: { complete: false, regions: [] },
    });

    await open(`${shop}/absolute-wall`);
    expect((await (await surface())(request)).statementRegions).toEqual({ complete: false, regions: [] });

    await open(`${shop}/statement-headings`);
    const headings = await surface();
    const structured = Schema.decodeUnknownSync(Regions)((await headings(request)).statementRegions);
    expect(structured.primaryHeading).toBe("Account overview");
    expect(structured.regions.map(({ heading, authorLabel, ancestorLabels, ambiguous }) =>
      ({ heading, authorLabel, ancestorLabels, ambiguous }))).toEqual([
      { heading: "Previous bill", authorLabel: "Paid statement", ancestorLabels: undefined, ambiguous: undefined },
      { heading: "Details", authorLabel: undefined, ancestorLabels: ["Previous bill", "Paid statement"], ambiguous: undefined },
      { heading: undefined, authorLabel: undefined, ancestorLabels: undefined, ambiguous: undefined },
      { heading: undefined, authorLabel: undefined, ancestorLabels: undefined, ambiguous: true },
      { heading: "Current invoice", authorLabel: undefined, ancestorLabels: undefined, ambiguous: undefined },
    ]);
    expect(structured.regions.at(-1)?.fragments).toEqual(["Current invoice", "Due August 12", "Amount due: $40"]);
    await tab.evaluate(() => {
      const duplicated = document.querySelector("#paid-title")?.cloneNode(true);
      if (duplicated) document.querySelector("main")?.append(duplicated);
    });
    expect(Schema.decodeUnknownSync(Regions)((await headings(request)).statementRegions).regions[0]).toMatchObject({ ambiguous: true });
    await tab.evaluate(() => {
      const conflicting = document.createElement("h1");
      conflicting.textContent = "Another account heading";
      document.querySelector("main")?.append(conflicting);
    });
    expect((await headings(request)).statementRegions).toEqual({ complete: false, regions: [] });
    await tab.evaluate(() => {
      const table = '<table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody>' +
        '<tr><td>Service</td><td>1</td><td>$40</td></tr><tr><td></td><td>Amount due</td><td>$40</td></tr></tbody></table>';
      document.querySelector("main")?.insertAdjacentHTML("beforeend", `
        <article><h2>Current invoice</h2><p>Due August 12</p><div id="line-items">${table}</div></article>
        <article><h2>Records</h2><table><thead><tr><th>Record</th><th>Status</th><th>Amount</th></tr></thead><tbody>
          <tr><td>Other account</td><td>Due</td><td>$90</td></tr><tr><th scope="row">Record identity</th><td>Open</td><td>$90</td></tr>
        </tbody></table></article>
        <article><h2>Unrelated account</h2><section>${table}</section></article>
        <article><h2>Nested billing</h2><table><tbody><tr><td>${table}</td></tr></tbody></table></article>
        `);
      document.querySelector("main > h1:last-of-type")?.remove();
    });
    const rows = async () => Schema.decodeUnknownSync(Regions)((await headings(request)).statementRegions).regions;
    const withRows = await rows();
    const owningSection = withRows.find(({ heading, fragments }) => heading === "Current invoice" && fragments.includes("Due August 12") && fragments.includes("Description"));
    const witnessedRows = withRows.filter(({ tableRow }) => tableRow !== undefined);
    expect(owningSection).toBeDefined();
    expect(witnessedRows.map(({ fragments, tableRow }) => ({ fragments, tableRow }))).toEqual([
      { fragments: ["Service", "1", "$40"], tableRow: { parentKey: owningSection?.key, columns: ["Description", "Qty", "Amount"] } },
      { fragments: ["Amount due", "$40"], tableRow: { parentKey: owningSection?.key, columns: ["Description", "Qty", "Amount"] } },
    ]);
    expect(witnessedRows.every(({ key }) => key !== owningSection?.key)).toBe(true);
    await tab.evaluate(() => {
      const previousCell = document.querySelector("#line-items tbody td");
      if (previousCell instanceof HTMLTableCellElement) previousCell.rowSpan = 2;
    });
    expect((await rows()).some(({ tableRow }) => tableRow !== undefined)).toBe(false);
    await tab.evaluate(() => {
      const previousCell = document.querySelector("#line-items tbody td");
      if (previousCell instanceof HTMLTableCellElement) previousCell.rowSpan = 1;
      const column = document.querySelector("#line-items th");
      if (column instanceof HTMLElement) column.style.visibility = "hidden";
    });
    expect((await rows()).some(({ tableRow }) => tableRow !== undefined)).toBe(false);
    await tab.evaluate(() => {
      const column = document.querySelector("#line-items th");
      if (column instanceof HTMLElement) {
        column.style.visibility = "";
        column.innerHTML = '<a href="/other">Description</a>';
      }
    });
    expect((await rows()).some(({ tableRow }) => tableRow !== undefined)).toBe(false);
  });

  it("answers a snapshot through installControlChannel in its own isolated world as page-command.mjs does", async () => {
    const shape = (raw: unknown) => {
      const read = fields(raw);
      return { elements: Schema.decodeUnknownSync(Schema.Array(Fields))(read.elements).map(({ label, targetSelector, sensitive, frame, inShadowRoot }) => ({ label, targetSelector, sensitive, frame, inShadowRoot })), childFrames: read.childFrames, blockers: read.blockers };
    };
    for (const url of [`${shop}/signin`, `${shop}/pay`, `${secure}/dashboard`]) {
      await open(url);
      const send = await surface();
      const read = await send({ subaction: "snapshot" });
      expect(text(read.snapshotId), url).toMatch(/^[0-9a-f-]{36}$/);
      expect(shape(read), url).toEqual(shape((await snapshot()).value));
    }
  });
});

describe('A task reads open shadow roots and frames on the page\'s origin (spec/os/browser/pageCommands.md, "An observation belongs to the live binding it was read under, and a read or an input holds none")', () => {
  it("reads an open shadow root's sign-in form with the password marked and no values, and never a closed root", async () => {
    await open(`${shop}/signin`);
    await snapshot();
    await tab.locator("#shadow-user").fill("reader-value");
    await tab.locator("#shadow-pass").fill("hunter2-secret");
    await tab.evaluate(`document.querySelector("northfield-login").shadowRoot.getElementById("echo").textContent = "hunter2-secret"`);
    const state = await snapshot();
    expect(find(state, "Username")).toMatchObject({ inShadowRoot: true, sensitive: null, hasInput: true, edited: true });
    expect(find(state, "Password")).toMatchObject({ sensitive: "password", hasInput: true });
    expect(selectorOf(find(state, "Next"))).toMatch(/ >>> #shadow-next$/);
    expect(find(state, "Next").frame).toBeUndefined();
    expect(JSON.stringify(state.value)).not.toMatch(/reader-value|hunter2-secret|Sealed words/);
    expect(state.text).toContain("[hidden]");
    expect(state.text).toContain("Welcome back");
    expect(state.value.childFrames).toEqual([]);
    expect(state.elements.filter((element) => ["Closed field", "Closed button"].includes(text(element.label)) || String(element.targetSelector).includes("closed"))).toEqual([]);
  });

  it("lets a task click reach the shadow root's control by its stepped selector, once", async () => {
    await open(`${shop}/signin`);
    let state = await snapshot();
    const next = selectorOf(find(state, "Next"));
    expect(await act(state, "click", "Next", { taskPolicy: policy(next) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["shadow-next"]);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    for (const selector of [`${next.split(" >>> ")[0]} >>> #shadow-user`, "sealed-box >>> #closed-button", "#shadow-next"])
      expect(await refusal(state, "click", "Next", { taskPolicy: policy(selector) }), selector).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual(["shadow-next"]);
  });

  it("makes references stale on a change, a new shadow root or typing inside the shadow root", async () => {
    await open(`${shop}/signin`);
    let state = await snapshot();
    await tab.evaluate(`document.querySelector("northfield-login").shadowRoot.querySelector("form").append("Checking")`);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`document.querySelector("h1").attachShadow({ mode: "open" })`);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    await tab.locator("#shadow-user").press("End");
    await tab.keyboard.type("x");
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    expect(await presses()).toEqual([]);
  });

  it("reads a same-origin frame's payment form with its frame and origin, card boxes marked, and never another origin's frame", async () => {
    await open(`${shop}/pay`);
    const card = tab.frameLocator("#card-frame").locator("#card");
    await card.fill("4111111111111111");
    const state = await snapshot({ taskPolicy: policy("#none") });
    const box = find(state, "Card number");
    expect(box).toMatchObject({ sensitive: "payment-card", hasInput: true, inViewport: true, frame: { index: 1, origin: shop, title: "Secure payment form" } });
    expect(find(state, "Security code").sensitive).toBe("payment-card");
    await near(box.bounds, card);
    const pay = find(state, "Pay now");
    expect(pay).toMatchObject({ submits: true, frame: { index: 1 }, form: { index: 0 } });
    expect(selectorOf(pay)).toMatch(/^#card-frame >>> /);
    expect(state.elements.filter((element) => element.label === "Card number")).toHaveLength(1);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames).map(({ bounds: _, ...frame }) => frame)).toEqual([
      { index: 1, read: true, origin: shop, parent: null, title: "Secure payment form" },
      { index: 2, read: false, reason: "other-origin", origin: null, parent: null, title: "Partner payment form" },
    ]);
    expect(state.value.omitted).toContain("the contents of frames on another origin (childFrames)");
    expect(state.text).toContain("Card words");
    expect(JSON.stringify(state.value)).not.toMatch(/Partner words|4111111111111111/);
  });

  it("keeps a frame's Pay button hers, and counts a card box or amount in a frame as money for the click guard", async () => {
    await open(`${shop}/pay`);
    let state = await snapshot({ taskPolicy: policy("#none") });
    expect(await refusal(state, "click", "Pay now", { taskPolicy: policy(selectorOf(find(state, "Pay now"))) })).toBe("POLICY_BLOCKED");
    state = await snapshot({ taskPolicy: policy("#none") });
    expect(await refusal(state, "click", "Show details", { taskPolicy: policy(selectorOf(find(state, "Show details"))) })).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual([]);
    await open(`${shop}/card-only`);
    state = await snapshot({ taskPolicy: policy("#top-details") });
    expect(await refusal(state, "click", "Show details", { taskPolicy: policy("#top-details") })).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual([]);
    await tab.locator("#card-frame").evaluate((frame) => { frame.style.opacity = "0"; });
    const hidden = await snapshot();
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(hidden.value.childFrames)[0]).toMatchObject({ read: false, reason: "not-rendered" });
    const top = find(hidden, "Show details");
    await tab.frameLocator("#card-frame").locator("body").evaluate((body) => { body.append("Changed after the frame was hidden"); });
    expect(await act(hidden, "click", "Show details", { taskPolicy: policy(selectorOf(top)) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["top-details"]);
  });

  it("clicks, fills and selects in the frame only, reads the fill back, refuses a follow there and stops the frame's own page change", async () => {
    await open(`${shop}/framed-plain`);
    let state = await snapshot();
    const details = find(state, "Show details");
    expect(details.frame).toMatchObject({ index: 1 });
    expect(await act(state, "click", "Show details", { taskPolicy: policy(selectorOf(details)) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["details"]);
    state = await snapshot();
    expect(await act(state, "fill", "Email", { text: "reader@example.test", taskPolicy: policy(selectorOf(find(state, "Email")), "fill") })).toMatchObject({ dispatched: true });
    state = await snapshot({ taskPolicy: policy("#none") });
    expect(fields(state.value.inputReadback).matches).toBe(true);
    expect(await act(state, "select", "How often", { text: "Monthly", taskPolicy: policy(selectorOf(find(state, "How often")), "select") })).toMatchObject({ dispatched: true });
    state = await snapshot();
    expect(await refusal(state, "follow", "Our terms", { taskPolicy: policy(selectorOf(find(state, "Our terms")), "follow") })).toBe("POLICY_BLOCKED");
    const frame = tab.frameLocator("#plain-frame");
    expect([await frame.locator("#email").inputValue(), await frame.locator("#often").inputValue(), tab.frames()[1]?.url()]).toEqual(["reader@example.test", "Monthly", `${shop}/plain-frame`]);
    await tab.evaluate(`document.getElementById("plain-frame").contentWindow.location.assign("/paid")`);
    await expect.poll(async () => (await snapshot({ taskPolicy: policy("#none") })).value.effectViolation).toBe("navigation");
    expect(tab.frames().find((frame) => frame.parentFrame() !== null)?.url()).toBe(`${shop}/plain-frame`);
  });

  it("makes references stale on a frame's change, input, address or origin, then lists the frame unread", async () => {
    await open(`${shop}/framed-plain`);
    let state = await snapshot();
    await tab.evaluate(`document.getElementById("plain-frame").contentDocument.body.append("Changed")`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.frameLocator("#plain-frame").locator("#email").fill("typed");
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`document.getElementById("plain-frame").contentWindow.history.pushState(null, "", "/plain-frame#moved")`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`new Promise((resolve) => { const frame = document.getElementById("plain-frame"); frame.addEventListener("load", resolve, { once: true }); frame.src = "${partner}/card-frame"; })`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    expect(state.elements.some((element) => element.frame)).toBe(false);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames)[0]?.read).toBe(false);
    expect(await presses()).toEqual([]);
  });

  it("reports a page layer over a frame's control as covering the target", async () => {
    await open(`${shop}/covered`);
    const state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "modal", covers: "target", overlay: true, ref: find(state, "Close").id })]);
  });

  it("says a sign-in wall or a dialog written into the page, or into the site's full-page app frame, is not a layer over it, and a positioned one is", async () => {
    for (const [path, blocker] of [
      ["/scoped-invitation", { kind: "login-wall", overlay: false, covers: "partial" }],
      ["/overlay-invitation", { kind: "login-wall", overlay: true, covers: "viewport" }],
      ...["footer-only", "disabled", "hidden", "placeholder", "external", "inert", "covered", "password", "code", "required"].map((fixture) =>
        [`/${fixture}-invitation`, { kind: "login-wall", overlay: false, covers: "viewport" }] as const),
      ["/paywall-invitation", { kind: "paywall", overlay: false, covers: "viewport" }],
      ["/captcha-invitation", { kind: "captcha", overlay: false, covers: "viewport" }],
      ["/wall", { kind: "login-wall", overlay: false }],
      ["/fixed-shell", { kind: "login-wall", overlay: false }],
      ["/absolute-shell", { kind: "login-wall", overlay: false }],
      ["/static-dialog", { kind: "modal", overlay: false }],
      ["/absolute-wall", { kind: "login-wall", overlay: true }],
      ["/fixed-banner", { kind: "cookie-consent", overlay: true }],
    ] as const) {
      await open(`${shop}${path}`);
      expect((await snapshot()).value.blockers, path).toEqual([expect.objectContaining(blocker)]);
    }
    await open(`${shop}/mixed-invitation`);
    expect((await snapshot()).value.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "login-wall", overlay: false, covers: "partial" }),
      expect.objectContaining({ kind: "login-wall", overlay: false, covers: "viewport", text: "Please sign in to continue." }),
    ]));
  });

  it("finds a dialog in a frame and a consent layer in an open root, with the controls that close them", async () => {
    await open(`${shop}/framed-modal`);
    let state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "modal", covers: "viewport", overlay: true, ref: find(state, "Close").id })]);
    await open(`${shop}/shadow-consent`);
    state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "cookie-consent", overlay: true, rejectRef: find(state, "Reject all").id })]);
  });

  it("rings a shadow root's box and a bordered frame's box where they are, and scrolls a frame's box into view", async () => {
    for (const [url, label, locator] of [
      [`${shop}/signin`, "Username", () => tab.locator("#shadow-user")],
      [`${shop}/pay`, "Card number", () => tab.frameLocator("#card-frame").locator("#card")],
    ] as const) {
      await guideOn(url, label);
      await near(await ring(), locator());
      await call(pageGuidance, [{ kind: "hide" }]);
    }
    await open(`${shop}/framed-plain`);
    await tab.evaluate(`(() => { const frame = document.getElementById("plain-frame"); frame.style.height = "80px"; frame.contentDocument.body.style.paddingTop = "400px"; })()`);
    const state = await snapshot();
    expect(find(state, "Email").inViewport).toBe(false);
    expect(await guide(state, "Email")).toMatchObject({ placement: "scrolled" });
    await expect.poll(guided, { timeout: 5000 }).toBe(true);
    await call(pageGuidance, [{ kind: "hide" }]);
  });

  it("drops a ring when its framed or shadow target changes", async () => {
    for (const [url, label, change] of [
      [`${shop}/framed-plain`, "Email", `document.getElementById("plain-frame").contentDocument.getElementById("email").placeholder = "changed"`],
      [`${shop}/signin`, "Username", `document.querySelector("northfield-login").shadowRoot.getElementById("shadow-user").placeholder = "changed"`],
    ] as const) {
      await guideOn(url, label);
      await tab.evaluate(change);
      await expect.poll(guided, { timeout: 5000 }).toBe(false);
      expect(await evaluate("globalThis.__elizaPageGuidanceV1.invalidated"), url).toBe(true);
    }
  });

  it("fills a sign-in identifier in a full-page frame's open root, never its password, and is not made stale by a hidden frame", async () => {
    await open(`${secure}/dashboard`);
    let state = await snapshot({ taskPolicy: policy("#none", "click", secure) });
    const user = find(state, "Username");
    expect(user).toMatchObject({ inShadowRoot: true, sensitive: null, frame: { index: 1, origin: secure, title: "logon" } });
    expect(find(state, "Password")).toMatchObject({ inShadowRoot: true, sensitive: "password" });
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames).map(({ bounds: _, ...frame }) => frame)).toEqual([
      { index: 1, read: true, origin: secure, parent: null, title: "logon" },
      { index: 2, read: false, reason: "not-rendered", origin: null, parent: null, title: "empty" },
    ]);
    expect(state.elements.filter((element) => element.label === "empty" || element.label === "Telemetry")).toEqual([]);
    expect(state.value.omitted).toContain("frames the page does not show (childFrames)");
    await tab.evaluate(`new Promise((resolve) => { const frame = document.querySelector('iframe[title="empty"]'); frame.contentDocument.body.append("ping"); frame.addEventListener("load", resolve, { once: true }); frame.contentWindow.location.assign("/empty?again"); })`);
    expect(await refusal(state, "fill", "Password", { text: "not-a-password", taskPolicy: policy(selectorOf(find(state, "Password")), "fill", secure) })).toBe("POLICY_BLOCKED");
    expect(await act(state, "fill", "Username", { text: "reader-id", taskPolicy: policy(selectorOf(user), "fill", secure) })).toMatchObject({ dispatched: true });
    state = await snapshot({ taskPolicy: policy("#none", "click", secure) });
    expect(fields(state.value.inputReadback).matches).toBe(true);
    expect(await act(state, "select", "Sign in with", { text: "Token", taskPolicy: policy(selectorOf(find(state, "Sign in with")), "select", secure) })).toMatchObject({ dispatched: true });
    state = await snapshot();
    expect(await refusal(state, "follow", "Forgot username or password?", { taskPolicy: policy(selectorOf(find(state, "Forgot username or password?")), "follow", secure) })).toBe("POLICY_BLOCKED");
    const frame = tab.frameLocator('iframe[name="logonbox"]');
    expect([await frame.locator("#userId #input").inputValue(), await frame.locator("#password #input").inputValue(), await frame.locator("#token").inputValue()]).toEqual(["reader-id", "", "Token"]);
    await open(`${secure}/verify`);
    const code = selectorOf(find(await snapshot(), "One-time code"));
    expect(code).toMatch(/^iframe.* >>> .* >>> #input$/);
    expect((await codeFill(code, { origin: secure })).dispatched).toBe(true);
    expect(await tab.frameLocator('iframe[name="logonbox"]').locator("#otp #input").inputValue()).toBe("123456");
    expect(fields((await codeRead(secure)).codeReadback).matches).toBe(true);
  });

  it("through the browser host, presses a bound frame control once, never reads a partner origin's frame, and goes on past a tab that never answers", async () => {
    await open(`${shop}/framed-plain`);
    const target = selectorOf(find(await snapshot(), "Show details"));
    const records: Fields = {};
    const held: { func: (...args: never[]) => unknown; args: unknown[] }[] = [];
    const handle = createCommandHandler({
      runtime: { id: "test-extension" },
      storage: { local: { get: (key: string) => Promise.resolve({ [key]: records[key] }), set: (values: Fields) => Promise.resolve(Object.assign(records, values)) } },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), get: () => Promise.resolve({ url: tab.url(), status: "complete" }) },
      webNavigation: { getAllFrames: async () => (await frameList()).map(({ frameId, documentId }) => ({ frameId, documentId })) },
      scripting: {
        executeScript: async (request: { target: { tabId: number; frameIds?: number[]; allFrames?: boolean }; func: (...args: never[]) => unknown; args: unknown[] }) => {
          if (request.target.tabId === 2) {
            held.push(request);
            return new Promise(() => {});
          }
          const chosen = (await frameList()).filter(({ frameId }) => request.target.allFrames === true || request.target.frameIds?.includes(frameId));
          return Promise.all(chosen.map(async ({ frameId, documentId, contextId }) => ({ frameId, documentId, result: await evaluate(`(${Function.prototype.toString.call(request.func)})(...${JSON.stringify(request.args)})`, await contextId()) })));
        },
      },
    });
    const send = async (message: Fields) => {
      let reply: unknown;
      await handle(message, { send: (value) => { reply = value; } }, () => true);
      return fields(reply);
    };
    expect(await send({ type: "command", id: "statement-regions", command: { subaction: "snapshot", id: "1", statementRegions: true } })).toMatchObject({
      ok: false, error: { kind: "POLICY_BLOCKED" },
    });
    const raw = Schema.decodeUnknownSync(Schema.Array(Fields))(fields((await send({ type: "command", id: "raw-1", command: { subaction: "snapshot", id: "1" } })).result).frames);
    expect(raw.map((read) => Schema.decodeUnknownSync(Schema.Array(Fields))(read.elements).filter((element) => element.label === "Show details").length)).toEqual([0, 1]);
    const taskContext = { actorId: "actor", accountId: "account", agentId: "agent", taskId: "task", epoch: 0 };
    expect(await send({
      type: "task-bind", id: "bind-1",
      binding: { ...taskContext, tabId: "1", bindingRevision: 1, origin: shop, origins: [shop, partner], expiresAt: Date.now() + 120_000, targets: [{ selector: target, action: "click" }], revoked: false },
    })).toMatchObject({ ok: true });
    const read = await send({ type: "command", id: "read-1", command: { subaction: "snapshot", id: "1", taskContext } });
    const top = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(fields(read.result).frames)[0]);
    const button = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(top.elements).find((element) => element.label === "Show details"));
    expect(text(button.selector)).toMatch(/^[0-9a-f-]{36}:0:\d+$/);
    expect(button.frame).toMatchObject({ origin: shop });
    expect(await send({ type: "command", id: "click-1", command: { subaction: "click", id: "1", selector: button.selector, expectedSelector: target, taskContext } })).toMatchObject({ ok: true });
    expect(await presses()).toEqual(["details"]);
    await open(`${shop}/pay`);
    const again = await send({ type: "command", id: "read-2", command: { subaction: "snapshot", id: "1", taskContext } });
    const frame = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(fields(again.result).frames)[0]);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(frame.childFrames).map((child) => child.read)).toEqual([true, false]);
    expect(text(frame.text)).not.toContain("Partner words");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = send({ type: "command", id: "hung-1", command: { subaction: "snapshot", id: "2" } });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    held.splice(0);
    expect(await hung).toMatchObject({ ok: false, error: { kind: "INCOMPLETE_SNAPSHOT", reason: "page-unresponsive" } });
    expect(await send({ type: "command", id: "read-3", command: { subaction: "snapshot", id: "1", taskContext } })).toMatchObject({ ok: true });
    await open(`${shop}/static-dialog`);
    const noticeId = crypto.randomUUID();
    const notice = Schema.decodeUnknownSync(Read)(await call(pageCommand, [{ subaction: "snapshot" }, noticeId]));
    const close = `${noticeId}:0:${text(fields(notice.elements.find((element) => element.label === "Close")).id)}`;
    expect(await send({ type: "command", id: "hung-2", command: { subaction: "click", id: "2", selector: close } })).toMatchObject({ ok: false, error: { kind: "UNCERTAIN_OUTCOME" } });
    const late = await Promise.all(held.splice(0).map(async (request) => evaluate(`(${Function.prototype.toString.call(request.func)})(...${JSON.stringify(request.args)})`, await realm())));
    expect(late).toMatchObject([{ error: { kind: "STALE_REF" } }]);
    expect(await presses()).toEqual([]);
  });
});

interface CodeFill { readonly text?: string; readonly targets?: readonly Fields[]; readonly grant?: boolean; readonly protect?: boolean; readonly node?: string; readonly origin?: string; readonly between?: () => Promise<unknown> }
const codePolicy = (targets: readonly Fields[], extra: Fields = {}, origin = codes) => ({ origin, expiresAt: Date.now() + 60_000, guidanceScope: "50", targets, ...extra });
const codeFill = async (selector: string, { text: typed = "123456", targets = [{ selector, action: "fill-code" }], grant = true, protect = true, node = selector, origin = codes, between }: CodeFill = {}): Promise<Fields> => {
  const id = `codes-${++sequence}`;
  const read = Schema.decodeUnknownSync(Read)(await call(pageCommand, [{ subaction: "snapshot", taskPolicy: codePolicy(targets, {}, origin) }, id]));
  const element = fields(read.elements.find((value) => value.targetSelector === node));
  await between?.();
  const commitGrant = { grantId: `code-grant-${++sequence}`, selector, expiresAt: Date.now() + 30_000 };
  const taskPolicy = codePolicy(targets, { expectedSelector: selector, ...(protect ? { protectedValueKind: "verification-code" } : {}), ...(grant ? { commitGrant } : {}) }, origin);
  const result = fields(await call(pageCommand, [{ subaction: "fill", snapshotId: id, nodeId: element.id, text: typed, taskPolicy }, null]));
  return { ...result, targetRef: `${id}:0:${String(element.id)}` };
};
const codeRead = async (origin = codes) => fields(await call(pageCommand, [{ subaction: "snapshot", taskPolicy: codePolicy([], {}, origin) }, `codes-${++sequence}`]));
const kindOf = (result: Fields) => fields(result.error).kind;
const valueOf = (selector: string) => tab.locator(selector).inputValue();
const group = (prefix: string, count: number, from = 1) => Array.from({ length: count }, (_, index) => ({ selector: `#${prefix}${from + index}`, action: "fill-code" }));
const sensitives = async (selectors: readonly string[]) => {
  const elements = Schema.decodeUnknownSync(Schema.Array(Fields))((await codeRead()).elements);
  return selectors.map((selector) => elements.find((element) => element.targetSelector === selector)?.sensitive);
};

describe('A consented code reaches a code box by its label or one box per digit (spec/os/browser/pageCommands.md, "The peer takes only the fixed page commands, and a request needs a live binding and its scope")', () => {
  it("fills a box its words name a code only with the host's marker, the grant and the reviewed box, and reads it back once", async () => {
    await open(`${codes}/label`);
    expect(await sensitives(["#code", "#six"])).toEqual(["one-time-code", null]);
    expect(kindOf(await codeFill("#code", { protect: false, grant: false, targets: [{ selector: "#code", action: "fill" }] }))).toBe("POLICY_BLOCKED");
    expect(kindOf(await codeFill("#code", { grant: false }))).toBe("POLICY_BLOCKED");
    expect(kindOf(await codeFill("#code", { node: "#name" }))).toBe("POLICY_BLOCKED");
    expect([await valueOf("#name"), await valueOf("#code")]).toEqual(["", ""]);
    const filled = await codeFill("#code");
    expect(filled.dispatched).toBe(true);
    expect(await valueOf("#code")).toBe("123456");
    const after = await codeRead();
    expect(after.codeReadback).toEqual({ targetRef: filled.targetRef, boxes: 1, matches: true });
    expect(after.inputReadback).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("123456");
    expect((await codeRead()).codeReadback).toBeUndefined();
    expect(kindOf(await codeFill("#name"))).toBe("POLICY_BLOCKED");
    expect(kindOf(await codeFill("#enter", { grant: false }))).toBe("POLICY_BLOCKED");
    for (const selector of ["#six", "#enter", "#temporary", "#confirm"]) {
      expect((await codeFill(selector)).dispatched, selector).toBe(true);
      expect([await valueOf(selector), fields((await codeRead()).codeReadback).matches], selector).toEqual(["123456", true]);
    }
    await open(`${codes}/marked`);
    expect((await codeFill("#marked", { grant: false })).dispatched).toBe(true);
    expect(fields((await codeRead()).codeReadback).matches).toBe(true);
  });

  it("never fills a card, CVV, PIN, password, bank, ID, payment-form, promo, coupon, referral, ZIP or area-code box as a code, marked or not", async () => {
    await open(`${codes}/refused`);
    expect(await sensitives(["#cvv", "#csc", "#paycode", "#pin", "#routing", "#bankcode", "#ssn", "#passport"])).toEqual(["payment-card", "payment-card", "payment-card", "password", "bank-account", "one-time-code", "government-id", "government-id"]);
    for (const selector of ["#cvv", "#csc", "#paycode", "#pw", "#pin", "#cccode", "#routing", "#bankcode", "#ssn", "#passport", "#markedcvv", "#nearcvv", "#formcvv", "#promo", "#coupon", "#referral", "#zip", "#area", "#markedpromo"]) {
      expect(kindOf(await codeFill(selector)), selector).toBe("POLICY_BLOCKED");
      expect(await valueOf(selector), selector).toBe("");
    }
    for (const selector of ["#markedcvv", "#nearcvv", "#formcvv", "#markedpromo"])
      expect(kindOf(await codeFill(selector, { grant: false })), selector).toBe("POLICY_BLOCKED");
  });

  it("writes one digit to each box of the one group in a form, and never returns the joined code", async () => {
    await open(`${codes}/digits`);
    const six = group("d", 6);
    for (const [why, options] of [
      ["no grant", { grant: false }],
      ["a shorter code", { text: "12345" }],
      ["a longer code", { text: "1234567" }],
      ["a box not reviewed", { targets: six.filter((_, index) => index !== 3) }],
      ["only the first box reviewed", { targets: six.slice(0, 1) }],
    ] as const)
      expect(kindOf(await codeFill("#d1", { targets: six, ...options })), why).toBe("POLICY_BLOCKED");
    expect(kindOf(await codeFill("#d2", { targets: six }))).toBe("POLICY_BLOCKED");
    expect(await Promise.all(six.map(({ selector }) => valueOf(selector)))).toEqual(["", "", "", "", "", ""]);
    await tab.evaluate(`document.getElementById("d4").animate([{ transform: "translateX(0)" }, { transform: "translateX(40px)" }], { duration: 1, delay: 3000, fill: "forwards" })`);
    const moved = await codeFill("#d1", { targets: six, between: () => tab.waitForFunction(`document.getElementById("d4").getAnimations().every((animation) => animation.playState === "finished")`) });
    expect(kindOf(moved), "a box moved since the snapshot").toBe("POLICY_BLOCKED");
    await tab.evaluate(`document.getElementById("d4").getAnimations().forEach((animation) => animation.cancel())`);
    await tab.locator("#d3").fill("9");
    expect(kindOf(await codeFill("#d1", { targets: six })), "a box already filled").toBe("POLICY_BLOCKED");
    expect(await Promise.all(six.map(({ selector }) => valueOf(selector)))).toEqual(["", "", "9", "", "", ""]);
    await open(`${codes}/digits`);
    const filled = await codeFill("#d1", { targets: six });
    expect(filled.dispatched).toBe(true);
    expect(await Promise.all(six.map(({ selector }) => valueOf(selector)))).toEqual(["1", "2", "3", "4", "5", "6"]);
    const after = await codeRead();
    expect(after.codeReadback).toEqual({ targetRef: filled.targetRef, boxes: 6, matches: true });
    expect(after.effectViolation).toBeUndefined();
    await tab.evaluate(`(() => { const echo = document.createElement("p"); echo.textContent = "You entered 123456."; document.body.append(echo); document.title = "Code 123456"; })()`);
    const echoed = await codeRead();
    expect(JSON.stringify(echoed)).not.toContain("123456");
    expect(echoed.text).toMatch(/You entered \[hidden\]\./);
    expect(echoed.title).toBe("Code [hidden]");
  });

  it("refuses a group across forms, in two runs, unnamed as a code, named as a PIN, card or gift code, in a form that asks for a card or bank account, holding a password, disabled or read-only box, or given letters for number boxes, and takes a code group in no form", async () => {
    for (const [path, first, targets, typed] of [
      ["/split", "#a1", [...group("a", 3), ...group("b", 3, 4)], "123456"],
      ["/two-runs", "#x1", [...group("x", 3), ...group("y", 3, 4)], "123456"],
      ["/unnamed", "#u1", group("u", 6), "123456"],
      ["/card-digits", "#k1", group("k", 4), "1234"],
      ["/pin", "#p1", group("p", 4), "1234"],
      ["/hidden-digit", "#h1", group("h", 6), "123456"],
      ["/states", "#o1", group("o", 6), "123456"],
      ["/states", "#r1", group("r", 6), "123456"],
      ["/number-digits", "#n1", group("n", 6), "12A456"],
      ["/number-digits", "#ncode", [{ selector: "#ncode", action: "fill-code" }], "AB12CD"],
      ["/marked-digits", "#m1", group("m", 6), "123456"],
      ["/paying-groups", "#q1", group("q", 6), "123456"],
      ["/paying-groups", "#w1", group("w", 6), "123456"],
      ["/paying-groups", "#v1", group("v", 6), "123456"],
    ] as const) {
      await open(`${codes}${path}`);
      expect(kindOf(await codeFill(first, { targets, text: typed, grant: first !== "#m1" })), `${path} ${first}`).toBe("POLICY_BLOCKED");
      expect(await Promise.all(targets.map(({ selector }) => valueOf(String(selector)))), path).toEqual(targets.map(() => ""));
    }
    await open(`${codes}/marked-digits`);
    expect((await codeFill("#m1", { targets: group("m", 6) })).dispatched).toBe(true);
    await open(`${codes}/grouped`);
    expect((await codeFill("#g1", { targets: group("g", 4), text: "4321" })).dispatched).toBe(true);
    expect(fields((await codeRead()).codeReadback).matches).toBe(true);
  });

  it("writes a code to an open root's digit boxes, named by a label inside the root, in no form", async () => {
    await open(`${codes}/otp-shadow`);
    const elements = Schema.decodeUnknownSync(Schema.Array(Fields))((await codeRead()).elements);
    const boxes = [1, 2, 3, 4, 5, 6].map((n) => ({ selector: text(elements.find((element) => element.label === `Digit ${n}`)?.targetSelector), action: "fill-code" }));
    expect(boxes.map(({ selector }) => selector.split(" >>> ").at(-1))).toEqual(["#d1", "#d2", "#d3", "#d4", "#d5", "#d6"]);
    const filled = await codeFill(boxes[0].selector, { targets: boxes });
    expect(filled.dispatched).toBe(true);
    expect(await Promise.all([1, 2, 3, 4, 5, 6].map((n) => tab.locator(`otp-input #d${n}`).inputValue()))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect((await codeRead()).codeReadback).toEqual({ targetRef: filled.targetRef, boxes: 6, matches: true });
  });

  it("takes a consented code through the WebView channel only with the grant's value hash, and spends the grant once", async () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const viaChannel = async (path: string, first: string, targets: readonly Fields[], { grantId = `channel-${++sequence}`, valueHash = hash("123456") } = {}) => {
      await open(`${codes}${path}`);
      const send = await surface();
      const read = await send({ subaction: "snapshot", taskPolicy: codePolicy(targets) });
      const node = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(read.elements).find((element) => element.targetSelector === first)).id;
      const fill = () => send({ subaction: "fill", snapshotId: read.snapshotId, nodeId: node, text: "123456", taskPolicy: codePolicy(targets, { expectedSelector: first, protectedValueKind: "verification-code", commitGrant: { grantId, selector: first, valueHash, expiresAt: Date.now() + 30_000 } }) });
      const outcome = (result: Fields) => String(result.error === undefined ? result.dispatched : kindOf(result));
      return [outcome(await fill()), outcome(await fill())];
    };
    expect(await viaChannel("/label", "#code", [{ selector: "#code", action: "fill-code" }])).toEqual(["true", "POLICY_BLOCKED"]);
    expect(await valueOf("#code")).toBe("123456");
    expect((await viaChannel("/label", "#code", [{ selector: "#code", action: "fill-code" }], { valueHash: hash("654321") }))[0]).toBe("POLICY_BLOCKED");
    expect(await valueOf("#code")).toBe("");
    expect((await viaChannel("/label", "#code", [{ selector: "#code", action: "fill-code" }], { valueHash: "not-a-hash" }))[0]).toBe("INVALID_REQUEST");
    expect((await viaChannel("/digits", "#d1", group("d", 6)))[0]).toBe("true");
    expect(await Promise.all(group("d", 6).map(({ selector }) => valueOf(selector)))).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("reads a code back and hides it in the page for fifteen minutes, and not after", async () => {
    const after = async (minutes: number) => {
      await open(`${codes}/label`);
      expect((await codeFill("#code")).dispatched).toBe(true);
      await evaluate(`(() => { const now = Date.now.bind(Date); Date.now = () => now() + ${minutes * 60_000}; })()`);
      const read = async () => fields(await call(pageCommand, [{ subaction: "snapshot", taskPolicy: { ...codePolicy([]), expiresAt: Date.now() + 60 * 60_000 } }, `codes-${++sequence}`]));
      const readback = (await read()).codeReadback;
      const matches = readback === undefined ? undefined : fields(readback).matches;
      await tab.evaluate(`(() => { document.getElementById("code").value = ""; const echo = document.createElement("p"); echo.textContent = "You entered 123456."; document.body.append(echo); })()`);
      return { matches, text: text((await read()).text).match(/You entered (\S+)\./)?.[1] };
    };
    expect(await after(14)).toEqual({ matches: true, text: "[hidden]" });
    expect(await after(16)).toEqual({ matches: undefined, text: "123456" });
  });

  it("stops a group that sends its form on the last digit, and reads back unknown when the page clears a box", async () => {
    await open(`${codes}/autosubmit`);
    expect((await codeFill("#s1", { targets: group("s", 6) })).dispatched).toBe(true);
    await expect.poll(async () => (await codeRead()).effectViolation).toBe("submit");
    expect(tab.url()).toBe(`${codes}/autosubmit`);
    await open(`${codes}/clearing`);
    expect((await codeFill("#c1", { targets: group("c", 6) })).dispatched).toBe(true);
    expect(fields((await codeRead()).codeReadback).matches).toBe(false);
  });
});

describe('A masked field reads back what was typed only with the mask\'s own marks (spec/os/browser/pageCommands.md, "An input is Dispatched only when the page confirms it, and Unknown otherwise")', () => {
  it("takes digits shown with spaces, dashes, brackets or slashes, and nothing else", async () => {
    await open(`${codes}/mask`);
    const masked = async (selector: string, typed: string) => {
      const result = await codeFill(selector, { text: typed, protect: false, grant: false, targets: [{ selector, action: "fill" }] });
      expect(result.dispatched, selector).toBe(true);
      const readback = fields((await codeRead()).inputReadback);
      expect(readback.targetRef).toBe(result.targetRef);
      return { shown: await valueOf(selector), matches: readback.matches, formatted: readback.formatted };
    };
    expect(await masked("#phone", "5551234567")).toEqual({ shown: "(555) 123-4567", matches: true, formatted: true });
    expect(await masked("#date", "10012026")).toEqual({ shown: "10/01/2026", matches: true, formatted: true });
    expect(await masked("#note", "Leave at the door")).toEqual({ shown: "Leave at the door", matches: true, formatted: undefined });
    expect(await masked("#phone", "555-123-4567")).toEqual({ shown: "(555) 123-4567", matches: false, formatted: undefined });
    expect(await masked("#amount", "1234")).toEqual({ shown: "12.34", matches: false, formatted: undefined });
    expect(await masked("#plus", "15551234567")).toEqual({ shown: "+1 (555) 123-4567", matches: false, formatted: undefined });
    expect(await masked("#blanks", "555123")).toEqual({ shown: "(555) 123-____", matches: false, formatted: undefined });
    expect(await masked("#lose", "5551234567")).toEqual({ shown: "(555) 123-456", matches: false, formatted: undefined });
    expect(await masked("#gain", "5551234567")).toEqual({ shown: "1 (555) 123-4567", matches: false, formatted: undefined });
    expect(await masked("#short", "7")).toEqual({ shown: "(7)", matches: false, formatted: undefined });
    expect(await masked("#short", "12")).toEqual({ shown: "(12)", matches: true, formatted: true });
    expect(await masked("#long", "1".repeat(32))).toEqual({ shown: "1111 ".repeat(8).trim(), matches: true, formatted: true });
    expect(await masked("#long", "1".repeat(33))).toEqual({ shown: `${"1111 ".repeat(8)}1`, matches: false, formatted: undefined });
    expect(kindOf(await codeFill("#mcode", { protect: false, grant: false, targets: [{ selector: "#mcode", action: "fill" }] }))).toBe("POLICY_BLOCKED");
    const filled = await codeFill("#mcode");
    expect(filled.dispatched).toBe(true);
    expect(await valueOf("#mcode")).toBe("123-456");
    const after = await codeRead();
    expect(after.codeReadback).toEqual({ targetRef: filled.targetRef, boxes: 1, matches: false });
    expect(after.inputReadback).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("123456");
  });
});

const sentBy = async (press: () => Promise<unknown>) => {
  sent.length = 0;
  await press();
  await expect.poll(() => sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
  return sent[0];
};
const formRead = async (path: string) => {
  await launch();
  for (const other of tab.context().pages()) if (other !== tab) await other.close();
  await open(`${bank}${path}`);
  const state = await snapshot();
  expect(JSON.stringify(state.value)).not.toMatch(/form-path|form-query|help@|void 0/);
  return state;
};

describe('A snapshot says where a submit or Enter would send its form (spec/os/browser/pageCommands.md, "An observation belongs to the live binding it was read under, and a read or an input holds none")', () => {
  const secure = { origin: "https://secure.bank.example", method: "post", newWindow: false };

  it("names another origin's sign-in action, a field's Enter and a button's overrides as Chromium sends them", async () => {
    let state = await formRead("/signin");
    expect(find(state, "Next").sends).toEqual(secure);
    expect(find(state, "User ID")).toMatchObject({ sends: null, form: { sends: secure } });
    expect(find(state, "Show tips")).toMatchObject({ submits: false, sends: null });
    expect(find(state, "Help signing in")).toMatchObject({ sends: { origin: bank, method: "get", newWindow: true }, form: { sends: secure } });
    expect(await sentBy(() => tab.locator("#user").press("Enter"))).toEqual(secure);
    state = await formRead("/signin");
    expect(await sentBy(() => tab.click("#help"))).toEqual(find(state, "Help signing in").sends);
  });

  it("names a relative GET form with no submit button by what Enter sends", async () => {
    const state = await formRead("/search");
    expect(state.elements.some((element) => element.submits)).toBe(false);
    expect(fields(find(state, "Search").form).sends).toEqual({ origin: bank, method: "get", newWindow: false });
    expect(await sentBy(() => tab.locator("#query").press("Enter"))).toEqual({ origin: bank, method: "get", newWindow: false });
  });

  it("gives a field its form's default button's request, override included", async () => {
    const state = await formRead("/transfer");
    const review = { origin: "https://review.bank.example", method: "post", newWindow: false };
    expect(fields(find(state, "Payee").form).sends).toEqual(review);
    expect(find(state, "Review").sends).toEqual(review);
    expect(find(state, "Send").sends).toEqual({ origin: bank, method: "post", newWindow: false });
    expect(await sentBy(() => tab.locator("#payee").press("Enter"))).toEqual(review);
  });

  it("says a form under the page's base target opens a new window, and names no Enter request where Enter sends nothing", async () => {
    let state = await formRead("/base");
    const receipt = { origin: "https://pay.bank.example", method: "post", newWindow: true };
    expect(find(state, "Send note").sends).toEqual(receipt);
    expect(await sentBy(() => tab.click("#send-note"))).toEqual(receipt);
    state = await formRead("/no-enter");
    expect([fields(find(state, "First name").form).sends, fields(find(state, "Account nickname").form).sends, fields(find(state, "Search").form).sends]).toEqual([null, null, { origin: "https://pay.bank.example", method: "get", newWindow: false }]);
    sent.length = 0;
    await tab.locator("#first").press("Enter");
    await tab.locator("#nickname").press("Enter");
    await tab.locator("#one").press("Enter");
    await expect.poll(() => sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(sent).toEqual([{ origin: "https://pay.bank.example", method: "get", newWindow: false }]);
  });

  it("names no origin for script, mail or dialog forms, and a named window as a new window", async () => {
    const state = await formRead("/other");
    expect(find(state, "Run script").sends).toEqual({ origin: null, method: "get", newWindow: false });
    expect(find(state, "Write to us").sends).toEqual({ origin: null, method: "post", newWindow: true });
    expect(find(state, "Close").sends).toEqual({ origin: null, method: "dialog", newWindow: false });
    const receipt = { origin: "https://pay.bank.example", method: "post", newWindow: true };
    expect(find(state, "Open receipt").sends).toEqual(receipt);
    expect(await sentBy(() => tab.click("#receipt"))).toEqual(receipt);
  });
});

describe('The page keeps a sign-on or log-on control the person\'s (spec/os/browser/pageCommands.md, "A commit grant is spent once, before the page sees it, even when the command is then refused")', () => {
  it("refuses a task click on Sign On or Log on without a grant, and presses a plain control", async () => {
    await open(`${shop}/sign-on`);
    for (const [label, selector] of [["Sign On", "#sign-on"], ["Log on", "#log-on"]] as const)
      expect(await refusal(await snapshot(), "click", label, { taskPolicy: policy(selector) }), label).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual([]);
    expect(await act(await snapshot(), "click", "Branch hours", { taskPolicy: policy("#hours") })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["hours"]);
  });
});
