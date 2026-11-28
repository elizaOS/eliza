// spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for"; spec/os/browser/surface/commands.md, "Reading needs the shown, loaded page, and a paused page is never driven or observed"
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyActionConsequence,
  COMMIT_CONTROL,
  dismissBlockerCommand,
  pageCommand,
} from "../browser/src/page-command.mjs";
import {
  classifyElementConsequence,
  createOpenAICompatiblePlanner,
  createPlaywrightWalkthroughTransport,
  createWalkthroughEngine,
  detectDarkPatterns,
  formatTelemetryJsonl,
  isOriginAllowed,
  parsePlannerAction,
  redactSensitiveText,
  sanitizeObservationForPlanner,
  stripUrlQuery,
  verifyCompletionQuotes,
} from "../browser/src/walkthrough-engine.mjs";

const portal = "https://secure.portal.example";
const paySub = "https://pay.portal.example";
const untrusted = "https://evil.example";

const readPageSource = readFileSync(
  new URL("../android/browser-surface/resources/read-page.js", import.meta.url),
  "utf8",
);
const pageCommandSource = pageCommand.toString();

let browser: Browser | undefined;
let page: Page;

async function ensureBrowser(): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.route(/^https:\/\/[a-z0-9.-]+\.example\//, (route) => {
      const url = new URL(route.request().url());
      const body = fixtures[`${url.origin}${url.pathname}`] ?? "<!doctype html><main><h1>Loaded</h1><p>Done</p></main>";
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    page = await context.newPage();
  }
  return page;
}

afterAll(async () => {
  await browser?.close();
});

const runPageCmd = async (
  cmd: Record<string, unknown>,
  snapshotId: string | null = null,
): Promise<Record<string, unknown>> =>
  page.evaluate(
    ([src, command, sid]) => {
      const fn = new Function(`return (${src});`)();
      return fn(command, sid, command?.validateOnly === true) as Record<
        string,
        unknown
      >;
    },
    [pageCommandSource, cmd, snapshotId] as const,
  );

const makePolicy = (
  origin: string,
  selector: string,
  action: string,
  extra: Record<string, unknown> = {},
) => ({
  origin,
  expiresAt: Date.now() + 60_000,
  guidanceScope: "wt-1",
  expectedSelector: selector,
  targets: [{ selector, action }],
  ...extra,
});

const fixtures: Record<string, string> = {
  [`${portal}/dashboard`]: `<!doctype html><html lang="en"><body>
    <header>
      <nav><a href="/accounts">Accounts</a><button type="button" id="signout">Sign out</button></nav>
    </header>
    <main>
      <h1>Account Dashboard</h1>
      <p class="tip">Please sign in from a trusted device when traveling abroad.</p>
      <article class="card">
        <h2>Rewards Card (...4821)</h2>
        <p>Statement balance: $482.15</p>
        <p>Minimum payment due: $35.00</p>
        <button type="button" id="pay-card" onclick="location.hash='#pay'; document.getElementById('view-state').textContent='Payment step 1';">Pay card</button>
      </article>
      <article class="card">
        <h2>Everyday Shopping</h2>
        <span class="badge">Sponsored</span>
        <p>Featured Battery Pack $19.99</p>
        <a id="ad-link" href="/item-sponsored">View sponsored pack</a>
      </article>
      <form id="wizard-form" method="get" action="/review">
        <label>Payment note <input id="note" type="text"></label>
        <button type="submit" id="continue-btn">Continue</button>
        <button type="submit" id="final-submit">Submit payment</button>
        <button type="button" id="pay-now-btn">Pay $482.15</button>
        <button type="button" id="add-cart-btn">Add to Cart</button>
        <button type="button" id="cancel-svc-btn">Cancel service</button>
      </form>
      <p id="view-state">Overview</p>
      <a id="sub-link" href="${paySub}/checkout">Open billing portal</a>
      <a id="evil-link" href="${untrusted}/phish">External offer</a>
      <a id="blank-sub" href="${paySub}/statements" target="_blank">Statements tab</a>
    </main>
    <footer><p>Please sign in to access archived paper records.</p></footer>
  </body></html>`,

  [`${portal}/widgets`]: `<!doctype html><html lang="en"><body>
    <main>
      <h1>Payment &amp; Schedule Form</h1>
      <custom-combobox id="funding"></custom-combobox>
      <custom-radios id="amount-choice"></custom-radios>
      <custom-date id="shadow-date"></custom-date>
      <div id="bs-date-wrap">
        <label for="visit-date">Visit date</label>
        <input id="visit-date" type="text" placeholder="dd/mm/yyyy" data-provide="datepicker">
        <div class="datepicker-days" style="display:none">
          <table><tbody><tr>
            <td class="day">14</td>
            <td class="day">15</td>
            <td class="day disabled">16</td>
          </tr></tbody></table>
        </div>
      </div>
      <div id="composer-wrap">
        <label id="msg-label">Care message</label>
        <div id="composer" contenteditable="true" role="textbox" aria-labelledby="msg-label" style="min-height:24px;border:1px solid #999"></div>
      </div>
      <label id="upload-trigger" for="hidden-file" style="display:inline-block;padding:4px 8px;border:1px solid #333">Upload insurance card</label>
      <input id="hidden-file" type="file" accept=".pdf,image/*" style="display:none">
      <input id="visible-file" type="file" accept=".pdf" aria-label="Attach lab report">
      <table id="legacy-form">
        <tbody>
          <tr><td>Payee Name:</td><td><input id="payee-name" name="payee.name" type="text"></td></tr>
          <tr><td>Demo Only:</td><td><input id="readonly-demo" type="text" readonly value="ReadonlyUser" placeholder="Username"></td></tr>
        </tbody>
      </table>
      <div><input id="tos" type="checkbox"> I agree with the terms of service</div>
      <div><input id="autopay-opt" type="checkbox" checked> Enroll in AutoPay automatically</div>
      <fieldset>
        <legend>Purchase frequency</legend>
        <label><input type="radio" name="freq" value="sub" checked> Subscribe &amp; Save (10% off)</label>
        <label><input type="radio" name="freq" value="once"> One-time purchase</label>
      </fieldset>
      <fieldset>
        <legend>Shipping speed</legend>
        <label><input type="radio" name="ship" value="express" checked> Express shipping ($14.99)</label>
        <label><input type="radio" name="ship" value="std"> Standard shipping (Free)</label>
      </fieldset>
      <iframe id="child-frame" src="/widgets-frame" title="Summary frame" style="width:400px;height:140px"></iframe>
      <p id="selected-account"></p>
      <p id="selected-amount"></p>
      <p id="event-log"></p>
    </main>
    <script>
      window.__events = [];
      const composer = document.getElementById("composer");
      for (const ev of ["focus", "beforeinput", "input", "change", "blur"]) {
        composer.addEventListener(ev, () => window.__events.push("composer:" + ev));
      }
      const payee = document.getElementById("payee-name");
      for (const ev of ["focus", "input", "change", "blur"]) {
        payee.addEventListener(ev, () => window.__events.push("payee:" + ev));
      }
      const visitDate = document.getElementById("visit-date");
      const cal = document.querySelector(".datepicker-days");
      visitDate.addEventListener("click", () => { cal.style.display = "block"; });
      visitDate.addEventListener("blur", () => {
        if (!visitDate.dataset.picked) visitDate.value = "";
      });
      for (const cell of document.querySelectorAll(".datepicker-days td.day:not(.disabled)")) {
        cell.addEventListener("click", () => {
          visitDate.dataset.picked = "1";
          visitDate.value = cell.textContent.padStart(2, "0") + "/12/2026";
          cal.style.display = "none";
        });
      }
      customElements.define("custom-combobox", class extends HTMLElement {
        connectedCallback() {
          const shadow = this.attachShadow({ mode: "open" });
          shadow.innerHTML = \`
            <button id="combo" role="combobox" aria-label="Pay from account" aria-expanded="false" aria-controls="acct-list">Choose account</button>
            <div id="acct-list" role="listbox" hidden>
              <div role="option" data-value="checking-1048">Total Checking (...1048)</div>
              <div role="option" data-value="external-6789">External Bank (...6789)</div>
            </div>
          \`;
          const btn = shadow.getElementById("combo");
          const list = shadow.getElementById("acct-list");
          btn.addEventListener("click", () => {
            const open = list.hidden;
            list.hidden = !open;
            btn.setAttribute("aria-expanded", String(open));
          });
          for (const opt of shadow.querySelectorAll("[role=option]")) {
            opt.addEventListener("click", () => {
              for (const o of shadow.querySelectorAll("[role=option]")) o.setAttribute("aria-selected", "false");
              opt.setAttribute("aria-selected", "true");
              btn.textContent = opt.textContent;
              list.hidden = true;
              btn.setAttribute("aria-expanded", "false");
              document.getElementById("selected-account").textContent = opt.getAttribute("data-value");
            });
          }
        }
      });
      customElements.define("custom-radios", class extends HTMLElement {
        connectedCallback() {
          const shadow = this.attachShadow({ mode: "open" });
          shadow.innerHTML = \`
            <div role="radiogroup" aria-label="Payment amount">
              <div role="radio" tabindex="0" aria-checked="false" data-value="statement">Statement balance ($482.15)</div>
              <div role="radio" tabindex="0" aria-checked="false" data-value="minimum">Minimum due ($35.00)</div>
            </div>
          \`;
          for (const r of shadow.querySelectorAll("[role=radio]")) {
            r.addEventListener("click", () => {
              for (const o of shadow.querySelectorAll("[role=radio]")) o.setAttribute("aria-checked", "false");
              r.setAttribute("aria-checked", "true");
              document.getElementById("selected-amount").textContent = r.getAttribute("data-value");
            });
          }
        }
      });
      customElements.define("custom-date", class extends HTMLElement {
        connectedCallback() {
          const shadow = this.attachShadow({ mode: "open" });
          shadow.innerHTML = \`<label>Payment date <input id="pdate" type="date"></label>\`;
        }
      });
    </script>
  </body></html>`,

  [`${portal}/widgets-frame`]: `<!doctype html><html lang="en"><body>
    <section><h2>Frame Billing Summary</h2>
      <table><thead><tr><th>Item</th><th>Amount</th></tr></thead>
      <tbody><tr><td>Monthly Plan</td><td>$89.00</td></tr></tbody></table>
    </section>
  </body></html>`,

  [`${portal}/read-page-test`]: `<!doctype html><html lang="en"><head><title>Shadow & Frame Read</title></head><body>
    <main>
      <h1>Main Headline</h1>
      <input type="password" value="SuperSecret999">
      <shadow-card><span slot="projected">Projected slot balance $120</span></shadow-card>
      <iframe id="same-frame" src="/widgets-frame" style="width:300px;height:120px"></iframe>
      <iframe id="hidden-frame" src="/widgets-frame" style="display:none"></iframe>
      <iframe id="cross-frame" src="${untrusted}/secret" style="width:300px;height:120px"></iframe>
    </main>
    <script>
      customElements.define("shadow-card", class extends HTMLElement {
        connectedCallback() {
          const s = this.attachShadow({ mode: "open" });
          s.innerHTML = '<section><p>Shadow inner details</p><slot name="projected"></slot><p style="display:none">Hidden shadow text</p></section>';
        }
      });
    </script>
  </body></html>`,

  [`${untrusted}/secret`]: `<!doctype html><body><p>Cross-origin secret text</p></body>`,

  [`${portal}/walkthrough-flow`]: `<!doctype html><html lang="en"><head><title>Walkthrough Flow</title></head><body>
    <main id="app">
      <h1>Bill Payment Portal</h1>
      <p>Account Balance: $150.00</p>
      <div id="upsell" role="dialog" aria-modal="true" style="position:fixed;inset:40px;background:#fff;border:2px solid #000;padding:16px">
        <h2>Enroll in AutoPay today!</h2>
        <p>Save time with automatic monthly payments.</p>
        <button type="button" id="enroll-autopay">Enroll in AutoPay</button>
        <button type="button" id="decline-autopay">Continue without enrolling</button>
      </div>
      <div id="step-1">
        <button type="button" id="start-pay">Pay card</button>
      </div>
      <div id="step-2" hidden>
        <h2>Review Payment</h2>
        <p>Paying $150.00 from Checking (...1048)</p>
        <button type="button" id="confirm-pay">Submit payment</button>
      </div>
      <div id="step-3" hidden>
        <h2>Payment Confirmation</h2>
        <p>Confirmation number: CONF-98231</p>
      </div>
    </main>
    <script>
      document.getElementById("decline-autopay").addEventListener("click", () => {
        document.getElementById("upsell").remove();
      });
      document.getElementById("start-pay").addEventListener("click", () => {
        document.getElementById("step-1").hidden = true;
        document.getElementById("step-2").hidden = false;
        location.hash = "#review";
      });
      document.getElementById("confirm-pay").addEventListener("click", () => {
        document.getElementById("step-2").hidden = true;
        document.getElementById("step-3").hidden = false;
        location.hash = "#confirmed";
      });
    </script>
  </body></html>`,
};

describe("Tiered consequence classifier and upgraded page-command.mjs primitives", () => {
  it("classifies routine wizard/navigation/staging actions separately from true irreversible commits", () => {
    expect(COMMIT_CONTROL.test("Pay card")).toBe(false);
    expect(COMMIT_CONTROL.test("Schedule an appointment")).toBe(false);
    expect(COMMIT_CONTROL.test("Continue")).toBe(false);
    expect(COMMIT_CONTROL.test("Next")).toBe(false);
    expect(COMMIT_CONTROL.test("Add to Cart")).toBe(false);
    expect(COMMIT_CONTROL.test("Review & verify")).toBe(false);
    expect(COMMIT_CONTROL.test("Submit payment")).toBe(true);
    expect(COMMIT_CONTROL.test("Pay $482.15")).toBe(true);
    expect(COMMIT_CONTROL.test("Pay $ 482.15")).toBe(true);
    expect(COMMIT_CONTROL.test("Pay 482.15")).toBe(true);
    expect(COMMIT_CONTROL.test("Pay USD 482.15")).toBe(true);
    expect(COMMIT_CONTROL.test("Book Appointment")).toBe(true);
    expect(COMMIT_CONTROL.test("Place your order")).toBe(true);
    expect(COMMIT_CONTROL.test("Confirm appointment")).toBe(true);
    expect(COMMIT_CONTROL.test("Send message")).toBe(true);
    expect(COMMIT_CONTROL.test("Cancel service")).toBe(true);

    expect(
      classifyActionConsequence({ tag: "button", type: "button", label: "Pay card" }).consequence,
    ).toBe("navigate");
    expect(
      classifyActionConsequence({ tag: "button", type: "submit", label: "Continue", submits: true }).consequence,
    ).toBe("navigate");
    expect(
      classifyActionConsequence({ tag: "button", type: "button", label: "Add to Cart" }).consequence,
    ).toBe("stage");
    expect(
      classifyActionConsequence({ tag: "button", type: "button", label: "No, thanks" }).consequence,
    ).toBe("observe");
    expect(
      classifyActionConsequence({ tag: "button", type: "button", label: "Cancel", inDialog: true }).consequence,
    ).toBe("observe");
    expect(
      classifyActionConsequence({ tag: "button", type: "button", label: "Submit payment" }),
    ).toMatchObject({ consequence: "commit", requiresGrant: true });
    expect(
      classifyActionConsequence(
        { tag: "button", type: "button", label: "Show details" },
        { hasPaymentCredentialField: true },
      ),
    ).toMatchObject({ consequence: "commit", requiresGrant: true });
  });

  it("allows routine clicks on $-displaying dashboards without false LOGIN_TEXT blockers, blocks true commits without grant, and supports same-site follow", async () => {
    const p = await ensureBrowser();
    await p.goto(`${portal}/dashboard`);

    const snap = await runPageCmd(
      { subaction: "snapshot", structuredRegions: true },
      "snap-dash-1",
    );
    expect(snap.complete).toBe(true);
    // Logged-in dashboard with "Sign out" must NOT false-trigger login-wall on security tips/footer!
    expect(snap.blockers).toEqual([]);

    const elements = snap.elements as Record<string, unknown>[];
    const byLabel = (label: string) =>
      elements.find((e) => e.label === label)!;

    expect(byLabel("Pay card").consequence).toBe("navigate");
    expect(byLabel("Continue").consequence).toBe("navigate");
    expect(byLabel("Add to Cart").consequence).toBe("stage");
    expect(byLabel("Submit payment").consequence).toBe("commit");
    expect(byLabel("Pay $482.15").consequence).toBe("commit");
    expect(byLabel("Cancel service").consequence).toBe("commit");

    // Routine "Pay card" click on page showing "$482.15" MUST succeed without commitGrant and without SPA effectViolation!
    const payCard = byLabel("Pay card");
    const payCardRes = await runPageCmd({
      subaction: "click",
      snapshotId: "snap-dash-1",
      nodeId: payCard.id,
      taskPolicy: makePolicy(portal, String(payCard.targetSelector), "click"),
    });
    expect(payCardRes.dispatched).toBe(true);
    expect(await p.locator("#view-state").textContent()).toBe("Payment step 1");

    const afterPayCard = await runPageCmd(
      {
        subaction: "snapshot",
        taskPolicy: makePolicy(portal, "#none", "click"),
      },
      "snap-dash-2",
    );
    expect(afterPayCard.effectViolation).toBeUndefined();

    // True irreversible commits MUST remain strictly POLICY_BLOCKED without commitGrant!
    for (const label of ["Submit payment", "Pay $482.15", "Cancel service"]) {
      const fresh = await runPageCmd({ subaction: "snapshot" }, `snap-${label}`);
      const el = (fresh.elements as Record<string, unknown>[]).find(
        (e) => e.label === label,
      )!;
      const blocked = await runPageCmd({
        subaction: "click",
        snapshotId: `snap-${label}`,
        nodeId: el.id,
        taskPolicy: makePolicy(portal, String(el.targetSelector), "click"),
      });
      expect((blocked.error as Record<string, unknown>)?.kind, label).toBe(
        "POLICY_BLOCKED",
      );
    }

    // maxConsequence="navigate" blocks "stage" ("Add to Cart") while permitting "navigate"
    const stageSnap = await runPageCmd({ subaction: "snapshot" }, "snap-stage");
    const addCart = (stageSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Add to Cart",
    )!;
    const blockedStage = await runPageCmd({
      subaction: "click",
      snapshotId: "snap-stage",
      nodeId: addCart.id,
      taskPolicy: makePolicy(portal, String(addCart.targetSelector), "click", {
        maxConsequence: "navigate",
      }),
    });
    expect((blockedStage.error as Record<string, unknown>)?.kind).toBe(
      "POLICY_BLOCKED",
    );

    // follow blocks untrusted origin, allows same-site subdomain when enabled
    const followSnap = await runPageCmd({ subaction: "snapshot" }, "snap-follow");
    const evil = (followSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "External offer",
    )!;
    const evilRes = await runPageCmd({
      subaction: "follow",
      snapshotId: "snap-follow",
      nodeId: evil.id,
      taskPolicy: makePolicy(portal, String(evil.targetSelector), "follow", {
        allowSameSiteSubdomains: true,
      }),
    });
    expect((evilRes.error as Record<string, unknown>)?.kind).toBe(
      "POLICY_BLOCKED",
    );

    const sub = (followSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Open billing portal",
    )!;
    const subValidated = await runPageCmd({
      subaction: "follow",
      snapshotId: "snap-follow",
      nodeId: sub.id,
      validateOnly: true,
      taskPolicy: makePolicy(portal, String(sub.targetSelector), "follow", {
        allowSameSiteSubdomains: true,
      }),
    });
    expect(subValidated.validated).toBe(true);

    const blankSub = (followSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Statements tab",
    )!;
    const blankValidated = await runPageCmd({
      subaction: "follow",
      snapshotId: "snap-follow",
      nodeId: blankSub.id,
      validateOnly: true,
      taskPolicy: makePolicy(portal, String(blankSub.targetSelector), "follow", {
        allowedOrigins: [paySub],
        allowNewTabFollow: true,
      }),
    });
    expect(blankValidated.validated).toBe(true);

    // Permitted non-commit GET submitter ("Continue") navigates cleanly to /review without effectViolation
    const continueBtn = (followSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Continue",
    )!;
    const navWait = p.waitForURL(`${portal}/review*`);
    const contRes = await runPageCmd({
      subaction: "click",
      snapshotId: "snap-follow",
      nodeId: continueBtn.id,
      taskPolicy: makePolicy(portal, String(continueBtn.targetSelector), "click"),
    });
    expect(contRes.dispatched).toBe(true);
    await navWait;
    expect(new URL(p.url()).pathname).toBe("/review");
  });

  it("supports ARIA combobox/radiogroup/datepicker in Shadow DOM, contenteditable fill with focus/blur, file-input surfacing, sibling td labels, and structuredRegions dark patterns", async () => {
    const p = await ensureBrowser();
    await p.goto(`${portal}/widgets`);

    let snap = await runPageCmd(
      { subaction: "snapshot", structuredRegions: true },
      "snap-w1",
    );
    const elements = snap.elements as Record<string, unknown>[];
    const sr = snap.structuredRegions as Record<string, unknown>;
    expect(sr.complete).toBe(true);
    expect(sr.pageHeading).toBe("Payment & Schedule Form");

    // Pierces same-origin iframe table inside structuredRegions even though benign form inputs exist
    const tables = sr.tables as Record<string, unknown>[];
    expect(
      tables.some((t) =>
        (t.columns as string[]).includes("Amount") && t.frameIndex === 1,
      ),
    ).toBe(true);

    // Detects pre-checked opt-in, recurring default, and paid default addon dark patterns
    const trapKinds = (sr.darkPatterns as { kind: string }[]).map((d) => d.kind);
    expect(trapKinds).toEqual(
      expect.arrayContaining([
        "pre-checked-opt-in",
        "recurring-default",
        "paid-default-addon",
      ]),
    );

    // Surfaces BOTH hidden-behind-label AND visible <input type="file">
    const fileInputs = sr.fileInputs as Record<string, unknown>[];
    expect(fileInputs).toHaveLength(2);
    expect(
      fileInputs.find((f) => f.accept === ".pdf,image/*"),
    ).toMatchObject({ hiddenInput: true, label: "Upload insurance card" });
    expect(fileInputs.find((f) => f.accept === ".pdf")).toMatchObject({
      hiddenInput: false,
      label: "Attach lab report",
    });

    // Sibling <td> label, following-sibling checkbox label, and readOnly surfacing
    const payee = elements.find((e) => e.fieldName === "payee.name")!;
    expect(payee.inferredLabel).toBe("Payee Name");
    const readonlyDemo = elements.find((e) => e.placeholder === "Username")!;
    expect(readonlyDemo.readOnly).toBe(true);
    const tos = elements.find((e) => e.targetSelector === "#tos")!;
    expect(String(tos.inferredLabel)).toContain("terms of service");

    // 1. Select ARIA combobox inside open Shadow DOM (opens closed popup and picks option!)
    const combo = elements.find((e) => e.label === "Pay from account")!;
    expect(combo.inShadowRoot).toBe(true);
    expect(Array.isArray(combo.options)).toBe(true);
    const comboRes = await runPageCmd({
      subaction: "select",
      snapshotId: "snap-w1",
      nodeId: combo.id,
      text: "External Bank (...6789)",
      taskPolicy: makePolicy(portal, String(combo.targetSelector), "select"),
    });
    expect(comboRes.dispatched).toBe(true);
    expect(await p.locator("#selected-account").textContent()).toBe(
      "external-6789",
    );

    // 2. Select ARIA radiogroup inside open Shadow DOM
    snap = await runPageCmd({ subaction: "snapshot" }, "snap-w2");
    const radioGroup = (snap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Payment amount",
    )!;
    const rgRes = await runPageCmd({
      subaction: "select",
      snapshotId: "snap-w2",
      nodeId: radioGroup.id,
      text: "Minimum due ($35.00)",
      taskPolicy: makePolicy(portal, String(radioGroup.targetSelector), "select"),
    });
    expect(rgRes.dispatched).toBe(true);
    expect(await p.locator("#selected-amount").textContent()).toBe("minimum");

    // 3. Select date on open Shadow DOM <input type="date">
    snap = await runPageCmd({ subaction: "snapshot" }, "snap-w3");
    const shadowDate = (snap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Payment date",
    )!;
    const sdRes = await runPageCmd({
      subaction: "select",
      snapshotId: "snap-w3",
      nodeId: shadowDate.id,
      text: "2026-12-15",
      taskPolicy: makePolicy(portal, String(shadowDate.targetSelector), "select"),
    });
    expect(sdRes.dispatched).toBe(true);
    expect(await p.locator("custom-date #pdate").inputValue()).toBe("2026-12-15");

    // 4. Select date on custom JS Bootstrap-style datepicker (clicks calendar cell, survives blur!)
    snap = await runPageCmd({ subaction: "snapshot" }, "snap-w4");
    const visitDate = (snap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Visit date",
    )!;
    const vdRes = await runPageCmd({
      subaction: "select",
      snapshotId: "snap-w4",
      nodeId: visitDate.id,
      text: "2026-12-15",
      taskPolicy: makePolicy(portal, String(visitDate.targetSelector), "select"),
    });
    expect(vdRes.dispatched).toBe(true);
    expect(await p.locator("#visit-date").inputValue()).toBe("15/12/2026");

    // 5. Fill contenteditable editor + verify focus/beforeinput/input/change/blur & inputReadback
    snap = await runPageCmd({ subaction: "snapshot" }, "snap-w5");
    const composer = (snap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Care message",
    )!;
    const fillComp = await runPageCmd({
      subaction: "fill",
      snapshotId: "snap-w5",
      nodeId: composer.id,
      text: "Please refill my blood pressure prescription.",
      taskPolicy: makePolicy(portal, String(composer.targetSelector), "fill"),
    });
    expect(fillComp.dispatched).toBe(true);
    expect(await p.locator("#composer").textContent()).toBe(
      "Please refill my blood pressure prescription.",
    );
    const readbackSnap = await runPageCmd(
      { subaction: "snapshot", taskPolicy: makePolicy(portal, "#none", "click") },
      "snap-w6",
    );
    expect(readbackSnap.inputReadback).toMatchObject({ matches: true });

    // Fill ordinary input and verify focus/input/change/blur sequence
    const payeeEl = (readbackSnap.elements as Record<string, unknown>[]).find(
      (e) => e.fieldName === "payee.name",
    )!;
    const fillPayee = await runPageCmd({
      subaction: "fill",
      snapshotId: "snap-w6",
      nodeId: payeeEl.id,
      text: "Springfield Electric",
      taskPolicy: makePolicy(portal, String(payeeEl.targetSelector), "fill"),
    });
    expect(fillPayee.dispatched).toBe(true);
    const events = await p.evaluate(() => (window as unknown as { __events: string[] }).__events);
    expect(events).toEqual(
      expect.arrayContaining([
        "composer:focus",
        "composer:beforeinput",
        "composer:input",
        "composer:change",
        "composer:blur",
        "payee:focus",
        "payee:input",
        "payee:change",
        "payee:blur",
      ]),
    );

    // 6. Attempt fill on <input type="file"> returns clean file-upload-requires-host-picker reason
    snap = await runPageCmd({ subaction: "snapshot" }, "snap-w7");
    const visibleFile = (snap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Attach lab report",
    )!;
    const fileFill = await runPageCmd({
      subaction: "fill",
      snapshotId: "snap-w7",
      nodeId: visibleFile.id,
      text: "/etc/passwd",
      taskPolicy: makePolicy(portal, String(visibleFile.targetSelector), "fill"),
    });
    expect(fileFill.error).toMatchObject({
      kind: "POLICY_BLOCKED",
      reason: "file-upload-requires-host-picker",
      accept: ".pdf",
    });
  });

  it("Android read-page.js pierces open Shadow DOM slots and same-origin iframes without leaking hidden/cross-origin/input secrets", async () => {
    const p = await ensureBrowser();
    await p.goto(`${portal}/read-page-test`);

    const result = await p.evaluate(
      (src) => {
        const fn = new Function(`return (${src});`)();
        return fn() as { url: string; title: string; text: string; truncated: boolean };
      },
      readPageSource,
    );
    expect(result.title).toBe("Shadow & Frame Read");
    expect(result.text).toContain("Main Headline");
    expect(result.text).toContain("Shadow inner details");
    expect(result.text).toContain("Projected slot balance $120");
    expect(result.text).toContain("Frame Billing Summary");
    expect(result.text).toContain("$89.00");
    expect(result.text).not.toContain("Hidden shadow text");
    expect(result.text).not.toContain("SuperSecret999");
    expect(result.text).not.toContain("Cross-origin secret text");
  });
});

describe("Upstream general walkthrough engine (walkthrough-engine.mjs)", () => {
  it("redacts secrets/SSNs/Luhn cards without wiping order IDs, validates planner JSON, and detects dark patterns", () => {
    const redacted = redactSensitiveText(
      "Order #123456 ZIP 02148 SSN 123-45-6789 Card 4111-1111-1111-1111 Bearer eyJhbGciOiJIUzI1NiJ9.secret https://a.test/?token=abc123&page=2",
    );
    expect(redacted).toContain("Order #123456");
    expect(redacted).toContain("ZIP 02148");
    expect(redacted).toContain("[redacted-ssn]");
    expect(redacted).toContain("[redacted-card]");
    expect(redacted).toContain("[redacted-secret]");
    expect(redacted).toContain("token=[redacted]&page=2");
    expect(stripUrlQuery("https://bank.example/pay?token=secret#step2")).toBe(
      "https://bank.example/pay",
    );

    expect(
      isOriginAllowed("https://pay.portal.example/step", {
        currentOrigin: "https://secure.portal.example",
        allowSameSiteSubdomains: true,
      }),
    ).toBe(true);
    expect(
      isOriginAllowed("https://evil.example/step", {
        currentOrigin: "https://secure.portal.example",
        allowSameSiteSubdomains: true,
      }),
    ).toBe(false);

    expect(parsePlannerAction('```json\n{"kind":"click","ref":"e2","reason":"Continue"}\n```')).toEqual({
      ok: true,
      action: { kind: "click", ref: "e2", reason: "Continue" },
    });
    expect(
      parsePlannerAction(
        '<think>Inspecting {raw} before choosing [e2]</think>\n{"kind":"click","ref":"[e2]","reason":"Normalized bracket ref"}',
      ),
    ).toEqual({
      ok: true,
      action: { kind: "click", ref: "e2", reason: "Normalized bracket ref" },
    });
    expect(parsePlannerAction('{"kind":"eval_js","code":"alert(1)"}').ok).toBe(false);

    expect(
      classifyElementConsequence({ tag: "input", type: "password", sensitive: "password" }),
    ).toMatchObject({ consequenceClass: "person_only", handoffKind: "NeedsPrivateSignIn" });
    expect(
      classifyElementConsequence({ tag: "input", type: "file" }),
    ).toMatchObject({ consequenceClass: "person_only", handoffKind: "NeedsFileUpload" });
    expect(
      classifyElementConsequence({ tag: "input", type: "text", sensitive: "one-time-code" }),
    ).toMatchObject({ consequenceClass: "person_only", handoffKind: "NeedsMFA" });
    // DOM-computed commit consequence is never downgraded, while inert radios remain stageable on payment pages
    expect(
      classifyElementConsequence({
        tag: "button",
        type: "submit",
        label: "Continue",
        consequence: "commit",
      }),
    ).toMatchObject({ consequenceClass: "commit", handoffKind: "NeedsCommitApproval" });
    expect(
      classifyElementConsequence(
        { tag: "input", type: "radio", label: "Checking" },
        { hasPaymentCredentialField: true },
      ),
    ).toMatchObject({ consequenceClass: "stage", requiresGrant: false });

    const quoteOk = verifyCompletionQuotes(["CONF-98231"], {
      title: "Done",
      text: "Payment complete. Confirmation number: CONF-98231",
    });
    expect(quoteOk.verified).toBe(true);
    const quoteHallucinated = verifyCompletionQuotes(["FAKE-00000"], {
      title: "Done",
      text: "Payment complete. Confirmation number: CONF-98231",
    });
    expect(quoteHallucinated.verified).toBe(false);
    expect(quoteHallucinated.missing).toEqual(["FAKE-00000"]);
  });

  it("dismissBlockerCommand chooses rejectRef on cookie banners and safe decline on upsell modals", () => {
    const cookieSnap = {
      snapshotId: "s1",
      blockers: [
        { kind: "cookie-consent", covers: "partial", rejectRef: "2", text: "Cookies" },
      ],
      elements: [
        { id: "1", label: "Accept all", targetSelector: "#accept", consequence: "commit" },
        { id: "2", label: "Reject all", targetSelector: "#reject", consequence: "observe" },
      ],
    };
    const plan = dismissBlockerCommand(cookieSnap);
    expect(plan?.element.id).toBe("2");
    expect(plan?.command.expectedSelector).toBe("#reject");

    const captchaSnap = {
      snapshotId: "s2",
      blockers: [{ kind: "captcha", covers: "viewport", text: "Verify you are human" }],
      elements: [],
    };
    expect(dismissBlockerCommand(captchaSnap)).toBeNull();
  });

  it("drives a real Playwright multi-step payment walkthrough: auto-dismisses AutoPay upsell, stages Pay card, pauses for NeedsCommitApproval, rejects hallucinated quote, then verifies real quote + zero-PII JSONL telemetry", async () => {
    const p = await ensureBrowser();
    await p.goto(`${portal}/walkthrough-flow`);

    const transport = createPlaywrightWalkthroughTransport(p, { settleMs: 50 });
    let planCalls = 0;
    const planner = {
      async plan(input: Record<string, unknown>) {
        planCalls++;
        const obs = input.observation as {
          controls: { ref: string; label: string; consequence: string }[];
          textExcerpt: string;
        };
        const findRef = (label: string) =>
          obs.controls.find((c) => c.label === label)?.ref;
        if (findRef("Pay card")) {
          return {
            action: { kind: "click" as const, ref: findRef("Pay card")!, reason: "Open payment review" },
            latencyMs: 12,
            tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          };
        }
        if (findRef("Submit payment")) {
          return {
            action: { kind: "click" as const, ref: findRef("Submit payment")!, reason: "Submit reviewed payment" },
            latencyMs: 15,
            tokenUsage: { promptTokens: 110, completionTokens: 22, totalTokens: 132 },
          };
        }
        if (obs.textExcerpt.includes("CONF-98231")) {
          if (planCalls === 3) {
            return {
              action: {
                kind: "complete" as const,
                summary: "Paid",
                quotes: ["HALLUCINATED-999"],
              },
              latencyMs: 10,
            };
          }
          return {
            action: {
              kind: "complete" as const,
              summary: "Paid $150.00 successfully",
              quotes: ["CONF-98231"],
            },
            latencyMs: 10,
          };
        }
        return { action: { kind: "block" as const, reason: "Unexpected state" } };
      },
    };

    const handoffsSeen: string[] = [];
    const engine = createWalkthroughEngine({
      goal: {
        id: "chase-flow-test",
        instruction: "Pay my $150.00 balance without enrolling in AutoPay",
        constraints: ["Do not enroll in AutoPay"],
        maxSteps: 10,
      },
      transport,
      planner,
      ports: {
        async onHandoff(handoff) {
          handoffsSeen.push(handoff.kind);
          if (handoff.kind === "NeedsCommitApproval") {
            return {
              kind: "approved",
              approved: true,
              commitGrant: {
                grantId: "grant-confirm-pay-1",
                selector: String(handoff.details?.targetSelector ?? "#confirm-pay"),
                expiresAt: Date.now() + 30_000,
              },
            };
          }
          return { kind: "rejected", reason: "unexpected handoff" };
        },
      },
    });

    const result = await engine.run();
    expect(result.status).toBe("completed");
    expect(result.quotesVerified).toBe(true);
    expect(result.quotes).toEqual(["CONF-98231"]);
    expect(handoffsSeen).toEqual(["NeedsCommitApproval"]);

    const jsonl = engine.getTelemetryJsonl();
    const lines = jsonl.split("\n").map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.some((e) => e.gateVerdict === "auto_dismissed")).toBe(true);
    expect(lines.some((e) => e.handoffKind === "NeedsCommitApproval")).toBe(true);
    expect(lines.every((e) => !String(e.urlOriginPath).includes("?"))).toBe(true);
  });

  it("handles NeedsCaptcha, NeedsPrivateSignIn pause/resume, loop fence, sponsored-ad blocking, and OpenAI-compatible planner wiring", async () => {
    // 1. Captcha immediately pauses with NeedsCaptcha without calling planner
    let plannerCalled = false;
    const captchaEngine = createWalkthroughEngine({
      goal: { instruction: "Check balance" },
      transport: {
        snapshot: async () => ({
          url: "https://example.test/check?token=secret",
          title: "Security Check",
          domRevision: 1,
          text: "Verify you are human",
          blockers: [{ kind: "captcha", covers: "viewport", text: "Verify you are human" }],
          elements: [],
        }),
        execute: async () => ({ dispatched: true }),
      },
      planner: {
        plan: async () => {
          plannerCalled = true;
          return { action: { kind: "block", reason: "never" } };
        },
      },
    });
    const captchaStep = await captchaEngine.step();
    expect(captchaStep.status).toBe("paused");
    expect(captchaStep.handoff?.kind).toBe("NeedsCaptcha");
    expect(plannerCalled).toBe(false);

    // 2. Sponsored listing click is deterministically blocked, and loop fence halts repeated stagnant clicks
    let stepNum = 0;
    const loopEngine = createWalkthroughEngine({
      goal: {
        instruction: "Buy AA batteries",
        maxRepeatedActionAttempts: 2,
        maxStagnantSteps: 3,
      },
      transport: {
        snapshot: async () => ({
          url: "https://shop.test/search?q=batteries",
          title: "Search",
          domRevision: 1,
          text: "Sponsored AA Batteries\nOrganic AA Batteries",
          blockers: [],
          elements: [
            { id: "0", tag: "a", label: "Sponsored AA Batteries", targetSelector: "#ad", consequence: "navigate" },
            { id: "1", tag: "button", label: "Organic AA Batteries", targetSelector: "#org", consequence: "navigate" },
          ],
          structuredRegions: {
            complete: true,
            darkPatterns: [{ kind: "sponsored-listing", ref: "0", label: "Sponsored AA Batteries", text: "Sponsored" }],
          },
        }),
        execute: async () => ({ dispatched: true }),
      },
      planner: {
        plan: async () => {
          stepNum++;
          if (stepNum === 1)
            return { action: { kind: "click", ref: "e0", reason: "Click top hit" } };
          return { action: { kind: "click", ref: "e1", reason: "Click organic hit" } };
        },
      },
    });
    const r1 = await loopEngine.step();
    expect(r1.telemetryEvent?.detail).toBe("dark-pattern:sponsored-listing");
    const r2 = await loopEngine.step();
    expect(r2.status).toBe("continue");
    const r3 = await loopEngine.step();
    expect(r3.status).toBe("continue");
    const r4 = await loopEngine.step();
    expect(r4.status).toBe("blocked");
    expect(r4.reason).toMatch(/Loop fence|stalled/i);

    // 3. OpenAI-compatible planner sends clean non-hardcoded request with max_tokens>=2048 and parses JSON
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth = "";
    const oaiPlanner = createOpenAICompatiblePlanner({
      baseUrl: "https://llm.example/v1",
      apiKey: "csk-test-never-logged",
      model: "any-model-id",
      disableReasoning: true,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ kind: "click", ref: "e0", reason: "Next step" }) } },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof globalThis.fetch,
    });
    const sanitized = sanitizeObservationForPlanner({
      url: "https://portal.test/home",
      title: "Home",
      domRevision: 1,
      text: "Welcome",
      blockers: [],
      elements: [
        { id: "0", tag: "button", label: "Continue", targetSelector: "#cont" },
        { id: "1", tag: "input", type: "text", label: "Demo", readOnly: true, targetSelector: "#ro" },
      ],
    });
    // Decorative readOnly text inputs are omitted from editable controls!
    expect((sanitized.observation.controls as unknown[]).length).toBe(1);
    const planned = await oaiPlanner.plan({
      goal: { instruction: "Continue", constraints: [] },
      stepIndex: 0,
      maxSteps: 10,
      observation: sanitized.observation,
      history: [],
      warnings: [],
      userAnswers: [],
    });
    expect(capturedBody.model).toBe("any-model-id");
    expect(capturedBody.max_tokens).toBe(2048);
    expect(capturedBody.disable_reasoning).toBe(true);
    expect(capturedAuth).toBe("Bearer csk-test-never-logged");
    expect(planned.action).toEqual({ kind: "click", ref: "e0", reason: "Next step" });
    expect(planned.tokenUsage).toEqual({ promptTokens: 50, completionTokens: 15, totalTokens: 65 });

    // Huge 120KB SPA tab pruning keeps in-viewport controls ahead of offscreen overflow and bounds payload size
    const hugeElements = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: String(i),
        tag: "button",
        label: `Claim item ${i}`,
        inViewport: false,
        targetSelector: `#c${i}`,
      })),
      {
        id: "120",
        tag: "button",
        label: "Benefits & Costs",
        inViewport: true,
        targetSelector: "#nav-benefits",
      },
    ];
    const pruned = sanitizeObservationForPlanner(
      {
        url: "https://portal.test/spa",
        title: "Claims",
        domRevision: 2,
        text: "Claim row ".repeat(15_000),
        blockers: [],
        elements: hugeElements,
      },
      { maxTextChars: 4000, maxControls: 20 },
    );
    expect(pruned.observation.truncated).toBe(true);
    expect((pruned.observation.textExcerpt as string).length).toBeLessThan(4100);
    expect(pruned.observation.truncatedControls).toBe(101);
    expect(
      (pruned.observation.controls as { label: string }[]).some(
        (c) => c.label === "Benefits & Costs",
      ),
    ).toBe(true);

    // Format telemetry JSONL strips secrets cleanly
    const jsonl = formatTelemetryJsonl([
      {
        timestamp: "2026-11-28T00:00:00Z",
        runId: "r1",
        stepIndex: 0,
        phase: "acting",
        urlOriginPath: "https://portal.test/step?otp=123456",
        domRevision: 1,
        candidateCount: 1,
        blockerKinds: [],
        darkPatternFlags: [],
        plannerActionKind: "click",
        targetLabel: "Pay with 123-45-6789",
        consequenceClass: "navigate",
        gateVerdict: "allowed",
        handoffKind: null,
        readbackVerified: true,
        domChanged: true,
        urlChanged: false,
        latencyMs: 5,
        tokenUsage: null,
      },
    ]);
    expect(jsonl).not.toContain("123456");
    expect(jsonl).not.toContain("123-45-6789");
    expect(jsonl).toContain("[redacted-ssn]");
    expect(
      detectDarkPatterns({
        blockers: [{ kind: "modal", text: "Try membership free", ref: "3" }],
        elements: [],
      }),
    ).toHaveLength(1);
  });

  it("handles POST wizard submits, SPA fetch+navigation commits, custom datepicker fill, handoff repeat fencing, multi-tab memory/quotes, prefilled fills, scroll fallback, 429 retries, and snapshot context-destroyed retries", async () => {
    const p = await ensureBrowser();

    // 1. Custom JS datepicker fill() commits value across blur & closes popup
    await p.goto(`${portal}/widgets`);
    const wSnap = await runPageCmd({ subaction: "snapshot" }, "snap-dp-fill");
    const visitDateEl = (wSnap.elements as Record<string, unknown>[]).find(
      (e) => e.label === "Visit date",
    )!;
    const fillDateRes = await runPageCmd({
      subaction: "fill",
      snapshotId: "snap-dp-fill",
      nodeId: visitDateEl.id,
      text: "15/12/2026",
      taskPolicy: makePolicy(portal, String(visitDateEl.targetSelector), "fill"),
    });
    expect(fillDateRes.dispatched).toBe(true);
    expect(await p.locator("#visit-date").inputValue()).toBe("15/12/2026");
    expect(await p.locator(".datepicker-days").isVisible()).toBe(false);

    // 2. Permitted POST wizard submit, SPA fetch on non-commit & commit-granted buttons, and commit-granted location.href navigation
    fixtures[`${portal}/post-wizard`] = `<!doctype html><body><main>
      <h1>Wizard Step 1</h1>
      <form method="post" action="/post-step2"><input name="a" value="1"><button type="submit" id="post-cont">Proceed to Payment</button></form>
      <button type="button" id="spa-tab">Load Benefits</button>
      <button type="button" id="spa-commit">Submit payment</button>
      <button type="button" id="nav-commit">Confirm</button>
      <p id="spa-out"></p>
      <script>
        document.getElementById("spa-tab").addEventListener("click", async () => {
          await fetch("/api/benefits");
          document.getElementById("spa-out").textContent = "Loaded benefits";
        });
        document.getElementById("spa-commit").addEventListener("click", async () => {
          await fetch("/api/pay", { method: "POST" });
          await fetch("/api/state");
          location.hash = "#paid";
          document.getElementById("spa-out").textContent = "Paid via SPA";
        });
        document.getElementById("nav-commit").addEventListener("click", () => {
          location.href = "/receipt";
        });
      </script>
    </main></body>`;
    fixtures[`${portal}/post-step2`] = `<!doctype html><body><main><h1>Wizard Step 2</h1></main></body>`;
    fixtures[`${portal}/receipt`] = `<!doctype html><body><main><h1>Receipt Confirmed</h1></main></body>`;
    fixtures[`${portal}/api/benefits`] = `{"plan":"Gold"}`;
    fixtures[`${portal}/api/pay`] = `{"ok":true}`;
    fixtures[`${portal}/api/state`] = `{"status":"paid"}`;

    await p.goto(`${portal}/post-wizard`);
    // 2a. Non-commit SPA fetch click produces zero effectViolation
    let snap = await runPageCmd({ subaction: "snapshot" }, "pw-s1");
    const spaTab = (snap.elements as Record<string, unknown>[]).find((e) => e.label === "Load Benefits")!;
    expect(
      (
        await runPageCmd({
          subaction: "click",
          snapshotId: "pw-s1",
          nodeId: spaTab.id,
          taskPolicy: makePolicy(portal, String(spaTab.targetSelector), "click"),
        })
      ).dispatched,
    ).toBe(true);
    await p.waitForTimeout(80);
    const afterSpaTab = await runPageCmd(
      { subaction: "snapshot", taskPolicy: makePolicy(portal, "#none", "click") },
      "pw-s2",
    );
    expect(afterSpaTab.effectViolation).toBeUndefined();
    expect(await p.locator("#spa-out").textContent()).toBe("Loaded benefits");

    // 2b. Commit-granted SPA click calling POST /api/pay + GET /api/state + location.hash produces zero effectViolation
    const spaCommit = (afterSpaTab.elements as Record<string, unknown>[]).find((e) => e.label === "Submit payment")!;
    expect(
      (
        await runPageCmd({
          subaction: "click",
          snapshotId: "pw-s2",
          nodeId: spaCommit.id,
          taskPolicy: makePolicy(portal, String(spaCommit.targetSelector), "click", {
            commitGrant: {
              grantId: "g-spa-1",
              selector: String(spaCommit.targetSelector),
              expiresAt: Date.now() + 30_000,
            },
          }),
        })
      ).dispatched,
    ).toBe(true);
    await p.waitForTimeout(80);
    const afterSpaCommit = await runPageCmd(
      { subaction: "snapshot", taskPolicy: makePolicy(portal, "#none", "click") },
      "pw-s3",
    );
    expect(afterSpaCommit.effectViolation).toBeUndefined();
    expect(await p.locator("#spa-out").textContent()).toBe("Paid via SPA");

    // 2c. Permitted non-commit POST wizard submit navigates cleanly to /post-step2
    const postCont = (afterSpaCommit.elements as Record<string, unknown>[]).find((e) => e.label === "Proceed to Payment")!;
    const postWait = p.waitForURL(`${portal}/post-step2`);
    expect(
      (
        await runPageCmd({
          subaction: "click",
          snapshotId: "pw-s3",
          nodeId: postCont.id,
          taskPolicy: makePolicy(portal, String(postCont.targetSelector), "click"),
        })
      ).dispatched,
    ).toBe(true);
    await postWait;
    expect(new URL(p.url()).pathname).toBe("/post-step2");

    // 2d. Commit-granted non-form button navigating via location.href reaches /receipt
    await p.goto(`${portal}/post-wizard`);
    snap = await runPageCmd({ subaction: "snapshot" }, "pw-s4");
    const navCommit = (snap.elements as Record<string, unknown>[]).find((e) => e.label === "Confirm")!;
    const receiptWait = p.waitForURL(`${portal}/receipt`);
    expect(
      (
        await runPageCmd({
          subaction: "click",
          snapshotId: "pw-s4",
          nodeId: navCommit.id,
          taskPolicy: makePolicy(portal, String(navCommit.targetSelector), "click", {
            commitGrant: {
              grantId: "g-nav-1",
              selector: String(navCommit.targetSelector),
              expiresAt: Date.now() + 30_000,
            },
          }),
        })
      ).dispatched,
    ).toBe(true);
    await receiptWait;
    expect(new URL(p.url()).pathname).toBe("/receipt");

    // 3. NeedsPrivateSignIn resume increments stepIndex, records history, and fences duplicate handoff once hasInput=true
    let passwordFilled = false;
    let handoffCalls = 0;
    let planTurn = 0;
    const handoffEngine = createWalkthroughEngine({
      goal: { instruction: "Register account", maxSteps: 10 },
      transport: {
        snapshot: async () => ({
          url: "https://portal.test/register",
          title: "Register",
          domRevision: passwordFilled ? 2 : 1,
          text: passwordFilled ? "Password entered. Ready to Register." : "Enter password to register.",
          blockers: [],
          elements: [
            {
              id: "0",
              tag: "input",
              type: "password",
              label: "Password",
              sensitive: "password",
              hasInput: passwordFilled,
              targetSelector: "#pw",
            },
            { id: "1", tag: "button", label: "Continue", targetSelector: "#go", consequence: "navigate" },
          ],
        }),
        execute: async () => ({ dispatched: true }),
      },
      planner: {
        plan: async (input) => {
          planTurn++;
          if (planTurn <= 2) {
            return {
              action: {
                kind: "request_handoff",
                handoffKind: "NeedsPrivateSignIn",
                ref: "e0",
                summary: "Fill password",
                reason: "Sensitive password",
              },
            };
          }
          expect((input.warnings as string[]).some((w) => /already completed/i.test(w))).toBe(true);
          expect((input.history as { action: string }[]).some((h) => h.action === "handoff:NeedsPrivateSignIn")).toBe(true);
          return {
            action: { kind: "complete", summary: "Done", quotes: ["Ready to Register"] },
          };
        },
      },
      ports: {
        onHandoff: async () => {
          handoffCalls++;
          passwordFilled = true;
          return { kind: "approved", humanCompleted: true };
        },
      },
    });
    const handoffRes = await handoffEngine.run();
    expect(handoffRes.status).toBe("completed");
    expect(handoffCalls).toBe(1);
    expect(handoffRes.stepIndex).toBeGreaterThanOrEqual(2);

    // 4. Multi-tab memoryNotes + cumulative trajectory-wide verifyCompletionQuotes
    let tabIndex = 0;
    let capturedNotes: string[] = [];
    const tabs = [
      { heading: "Allergies", text: "Active Allergy: Pollen" },
      { heading: "Care Team", text: "Primary Doctor: Dr. Kara Bickham" },
      { heading: "Test Results", text: "Lab Result: Urea nitrogen Abnormal" },
    ];
    const multiTabEngine = createWalkthroughEngine({
      goal: { instruction: "Check allergies, care team, and test results" },
      transport: {
        snapshot: async () => ({
          url: "https://spa.test/portal",
          title: "Patient Portal",
          domRevision: tabIndex + 1,
          text: tabs[tabIndex].text,
          blockers: [],
          structuredRegions: { pageHeading: tabs[tabIndex].heading },
          elements: [
            { id: "0", tag: "button", label: "Next Tab", targetSelector: "#next", consequence: "navigate" },
          ],
        }),
        execute: async () => {
          tabIndex = Math.min(tabIndex + 1, tabs.length - 1);
          return { dispatched: true };
        },
      },
      planner: {
        plan: async (input) => {
          capturedNotes = (input.memoryNotes as string[]) ?? [];
          if (tabIndex === 0)
            return {
              action: { kind: "click", ref: "e0", reason: "Next", note: "Allergy: Pollen" },
            };
          if (tabIndex === 1)
            return {
              action: { kind: "click", ref: "e0", reason: "Next", note: "Doctor: Dr. Kara Bickham" },
            };
          return {
            action: {
              kind: "complete",
              summary: "Found Pollen, Dr. Kara Bickham, Urea nitrogen",
              quotes: ["Pollen", "Dr. Kara Bickham", "Urea nitrogen"],
            },
          };
        },
      },
    });
    const mtRes = await multiTabEngine.run();
    expect(mtRes.status).toBe("completed");
    expect(mtRes.quotesVerified).toBe(true);
    expect(capturedNotes).toEqual([
      "[Allergies] Allergy: Pollen",
      "[Care Team] Doctor: Dr. Kara Bickham",
    ]);

    // 5. Prefilled fill (readbackVerified=true, unchanged DOM) does not trigger stagnation, scroll falls back to container, dismiss_blocker without rejectRef fences cleanly
    let execLog: Record<string, unknown>[] = [];
    let scriptStep = 0;
    const edgeEngine = createWalkthroughEngine({
      goal: { instruction: "Verify amount and scroll", maxStagnantSteps: 2 },
      transport: {
        snapshot: async () => ({
          url: "https://edge.test/pay",
          title: "Pay",
          domRevision: 1,
          text: "Amount $118.40",
          blockers: [{ kind: "cookie-consent", covers: "partial", text: "Cookies" }],
          elements: [
            { id: "0", tag: "input", type: "text", label: "Amount", hasInput: true, targetSelector: "#amt" },
            { id: "1", tag: "button", label: "Not Scrollable", targetSelector: "#btn" },
            { id: "2", tag: "div", label: "Scroller", scroll: { y: true }, scrollOnly: true, targetSelector: "#scroll" },
          ],
        }),
        execute: async (cmd) => {
          execLog.push(cmd);
          return { dispatched: true };
        },
      },
      planner: {
        plan: async () => {
          scriptStep++;
          if (scriptStep === 1)
            return { action: { kind: "fill", ref: "e0", text: "118.40", reason: "Confirm amount" } };
          if (scriptStep === 2)
            return { action: { kind: "scroll", direction: "down", ref: "e1", reason: "Scroll page" } };
          return { action: { kind: "dismiss_blocker", reason: "Try dismiss" } };
        },
      },
    });
    const eStep1 = await edgeEngine.step();
    expect(eStep1.state.stagnantSteps).toBe(0);
    const eStep2 = await edgeEngine.step();
    expect(eStep2.status).toBe("continue");
    expect(execLog[1]?.expectedSelector).toBe("#scroll");
    await edgeEngine.step();
    const eStep4 = await edgeEngine.step();
    expect(eStep4.status).toBe("blocked");
    expect(eStep4.reason).toMatch(/dismiss_blocker/i);

    // 6. OpenAI-compatible planner retries HTTP 429 & 503 with backoff and succeeds
    let fetchAttempts = 0;
    const retryPlanner = createOpenAICompatiblePlanner({
      baseUrl: "https://llm.example/v1",
      model: "test-model",
      retryBaseDelayMs: 5,
      sleep: async () => {},
      fetch: (async () => {
        fetchAttempts++;
        if (fetchAttempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        if (fetchAttempts === 2) return new Response("unavailable", { status: 503 });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ kind: "click", ref: "e0", reason: "Recovered", note: "OK" }) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof globalThis.fetch,
    });
    const retryOut = await retryPlanner.plan({
      goal: { instruction: "Test", constraints: [] },
      stepIndex: 0,
      maxSteps: 5,
      observation: {},
      memoryNotes: ["Saved fact"],
      history: [],
      warnings: [],
      userAnswers: [],
    });
    expect(fetchAttempts).toBe(3);
    expect(retryOut.action).toEqual({ kind: "click", ref: "e0", reason: "Recovered", note: "OK" });

    // 7. createPlaywrightWalkthroughTransport.snapshot() retries transparently on Execution context was destroyed
    let evalCalls = 0;
    const flakyTransport = createPlaywrightWalkthroughTransport(
      {
        url: () => "https://spa.test/redirecting",
        evaluate: (async () => {
          evalCalls++;
          if (evalCalls === 1) throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
          return { url: "https://spa.test/ready", title: "Ready", text: "Loaded", elements: [], blockers: [] };
        }) as never,
        goto: async () => {},
        goBack: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
      },
      { settleMs: 0, networkIdleTimeoutMs: 0 },
    );
    const recoveredSnap = await flakyTransport.snapshot();
    expect(evalCalls).toBe(2);
    expect(recoveredSnap.title).toBe("Ready");
  });
});
