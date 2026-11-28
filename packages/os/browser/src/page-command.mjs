/** Fixed DOM operations shared by Chromium and embedded native pages. No host imports. */

/**
 * Words on a control that commits a payment, sign-in, submission or other
 * irreversible external step. A task policy without a commit grant can never
 * click such a control; routine navigation and staging steps (such as
 * "Pay card", "Continue", "Next", "Review", "Add to Cart") are excluded so
 * multi-step workflows are not falsely blocked. This module imports nothing.
 */
export const COMMIT_CONTROL =
  /\b(?:submit(?:\s+(?:payment|order|form|application|request|claim|message|transfer|bill|now))?|confirm(?:\s+(?:payment|order|appointment|booking|cancellation|transfer|purchase|and\s+pay|&\s*pay|and\s+submit|&\s*submit))?|pay\s+(?:now|today|in\s+full|total|balance|amount|\p{Sc}\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|(?:usd|eur|gbp|cad|aud)\s*\d+(?:[.,]\d+)?)|(?:complete|finalize|authori[sz]e|process|execute)\s+(?:payment|order|purchase|transfer|transaction|checkout|booking|appointment)|place\s+(?:my\s+|your\s+|the\s+)?order|order\s+now|buy\s+now|purchase\s+now|book\s+(?:now|appointment|visit|booking)|reserve\s+now|sign\s*in|sign\s*on|log\s*in|log\s*on|sign\s*up|create\s+(?:an?\s+)?account|register|send(?:\s+(?:message|reply|email|payment|money|transfer|now))?|post\s+(?:comment|reply|message|now)|publish|delete|remove\s+account|close\s+account|cancel\s+(?:service|subscription|membership|plan|order|appointment|booking|payment|account|policy)|authori[sz]e|agree\s+and\b|accept\s+(?:all|and\b|terms|offer|trial)|transfer(?:\s+funds)?|wire(?:\s+funds)?|donate|subscribe|enroll(?:\s+in\b)?|start\s+(?:free\s+)?trial|verify\s+(?:code|identity|account|payment|now))\b|^(?:buy|purchase|verify|check\s*out)$/iu;

/** Ordered action consequence tiers from least to most consequential. */
export const ACTION_CONSEQUENCE_ORDER = Object.freeze([
  "observe",
  "navigate",
  "stage",
  "commit",
]);

/**
 * Runs one fixed page command in the page. The browser extension and the
 * native surface run it in an isolated world and keep its state on that
 * world's `globalThis`.
 *
 * `host` is optional. A trusted host that must run this function in the
 * page's own world (for example a development preview with no isolated
 * world) passes `{ scope, ownedHosts }`:
 * - `scope` is an object that the host makes and keeps in its own closure.
 *   The state of this function (snapshot elements, page observation, effect
 *   watch and spent commit grants) is kept on it, not on `globalThis`, so
 *   page script cannot read or replace it. The host can find the element of a
 *   snapshot id at `scope.__elizaBrowserControlV1.nodes.get(id).node` until
 *   the next effect.
 * - `ownedHosts` (optional) is a WeakSet of elements that the host draws on
 *   the page itself. Blockers ignore them, and adding or removing one does not
 *   make a snapshot stale. It is read when this document is first observed.
 * A scope does not protect the browser's own objects: page script in the same
 * world can still replace them. Where an isolated world exists, use it.
 * Page guidance keeps its state on `globalThis`, so with a scope a task
 * policy that names a guidance `actionId` is denied.
 */
export function pageCommand(
  command,
  snapshotId,
  validateOnly = false,
  host = undefined,
) {
  const policy = command?.taskPolicy;
  const denied = () => ({
    error: {
      kind: "POLICY_BLOCKED",
      message:
        "This action requires the person or a new authorized task observation.",
    },
  });
  if (
    host !== undefined &&
    (!host ||
      typeof host.scope !== "object" ||
      host.scope === null ||
      (host.ownedHosts !== undefined && !(host.ownedHosts instanceof WeakSet)))
  )
    return {
      error: {
        kind: "INVALID_REQUEST",
        message: "A host scope must be an object the host keeps.",
      },
    };
  if (Date.now() >= command?.answerBy)
    return {
      error: {
        kind: "STALE_REF",
        message:
          "The browser stopped waiting for this action before it ran; it was not performed.",
      },
    };
  const store = host === undefined ? globalThis : host.scope;
  if (
    policy &&
    (window !== window.top ||
      location.origin !== policy.origin ||
      Date.now() >= policy.expiresAt)
  )
    return denied();
  const key = "__elizaBrowserControlV1";
  const monitorKey = "__elizaBrowserObservationV1";
  const watchKey = "__elizaTaskEffectWatchV1";
  // What the network watch needs from this realm (effect-watch.mjs): her
  // presses, her first activated control, and the granted commit's address.
  const handoffOf = (watch) => ({
    presses: watch.presses,
    activatedAt: watch.activatedAt,
    consentedUrls: watch.consentedUrls,
    expected: watch.expected,
  });
  const grantKey = "__elizaCommitGrantsV1";
  // A host-issued grant for the one commit the person said yes to. The bridge
  // checked task, epoch, origin, observation and value and spent it there; the
  // page checks the control, the time and that this document never used it.
  const grant =
    policy?.commitGrant &&
    ["click", "fill", "select"].includes(command.subaction) &&
    typeof policy.commitGrant.grantId === "string" &&
    policy.commitGrant.selector === policy.expectedSelector &&
    Date.now() < policy.commitGrant.expiresAt &&
    !(
      store[grantKey]?.document === document &&
      store[grantKey].used.has(policy.commitGrant.grantId)
    )
      ? policy.commitGrant
      : null;
  if (policy?.commitGrant && !grant && command.subaction !== "snapshot")
    return denied();
  const realmOf = (node) => node?.ownerDocument?.defaultView ?? window;
  const is = (node, type) =>
    node !== null &&
    typeof node === "object" &&
    node instanceof (realmOf(node)[type] ?? globalThis[type]);
  const styleOf = (node) => realmOf(node).getComputedStyle(node);
  let monitor = store[monitorKey];
  if (
    !monitor ||
    monitor.document !== document ||
    typeof monitor.updateRoots !== "function"
  ) {
    monitor = {
      document,
      domRevision: 0,
      inputRevision: 0,
      ownedHosts: host?.ownedHosts ?? new WeakSet(),
      fromDocumentStart: command === null && document.readyState === "loading",
      editedFields: new WeakSet(),
      roots: new Map(),
    };
    monitor.recordMutations = (records) => {
      if (
        records.some(
          (record) =>
            !(
              // A registered guide can live inside a modal's non-inert
              // subtree. Only changes consisting entirely of owned hosts
              // are excluded; ordinary page mutations still invalidate refs.
              record.type === "childList" &&
              [...record.addedNodes, ...record.removedNodes].length > 0 &&
              [...record.addedNodes, ...record.removedNodes].every((node) =>
                monitor.ownedHosts.has(node),
              )
            ),
        )
      )
        monitor.domRevision++;
    };
    monitor.observer = new MutationObserver(monitor.recordMutations);
    const input = (event) => {
      monitor.inputRevision++;
      if (is(event?.target, "Element")) {
        monitor.editedFields.add(event.target);
        for (const item of event.composedPath()) {
          if (is(item, "HTMLElement") && item.isContentEditable)
            monitor.editedFields.add(item);
        }
      }
    };
    const press = (event) => {
      if (event.isTrusted) input();
    };
    monitor.updateRoots = (roots) => {
      const active = new Set(roots);
      const departed = [...monitor.roots.keys()].filter((root) => !active.has(root));
      const added = roots.filter((root) => !monitor.roots.has(root));
      if (departed.length === 0 && added.length === 0) return;
      for (const root of departed) {
        monitor.roots.get(root).abort();
        monitor.roots.delete(root);
      }
      if (departed.length > 0) monitor.observer.disconnect();
      for (const root of added) {
        const controller = new AbortController();
        const options = { capture: true, signal: controller.signal };
        root.addEventListener("beforeinput", input, options);
        root.addEventListener("input", input, options);
        root.addEventListener("change", input, options);
        root.addEventListener("pointerdown", press, options);
        monitor.roots.set(root, controller);
      }
      for (const root of departed.length > 0 ? roots : added)
        monitor.observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      monitor.domRevision++;
    };
    monitor.updateRoots([document]);
    store[monitorKey] = monitor;
  }
  if (command === null) return;
  // Drain queued mutations synchronously as an effect may arrive before the
  // MutationObserver microtask. Never store or return form values in this monitor.
  monitor.recordMutations(monitor.observer.takeRecords());
  const descend =
    command.subaction === "snapshot"
      ? command.childFrames !== false
      : store[key]?.descend !== false;
  const walk = () => {
    const parts = [];
    const frames = [];
    const order = [];
    const skipOwned = (node) =>
      monitor.ownedHosts.has(node)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    const rendered = (element) => {
      const rect = element.getBoundingClientRect();
      const view = element.ownerDocument.defaultView;
      const page =
        element.ownerDocument.scrollingElement ??
        element.ownerDocument.documentElement;
      return (
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right + view.scrollX > 0 &&
        rect.bottom + view.scrollY > 0 &&
        rect.left + view.scrollX <
          Math.max(page.scrollWidth, view.innerWidth) &&
        rect.top + view.scrollY < Math.max(page.scrollHeight, view.innerHeight)
      );
    };
    const enter = (root, frame) => {
      const part = { root, frame };
      parts.push(part);
      const doc = root.ownerDocument ?? root;
      const start = root === doc ? (doc.body ?? doc.documentElement) : root;
      if (!start) return;
      if (frame && root === doc && doc.scrollingElement)
        order.push({ node: doc.scrollingElement, part, frameRoot: true });
      if (start !== root && start.shadowRoot) enter(start.shadowRoot, frame);
      const walker = doc.createTreeWalker(
        start,
        NodeFilter.SHOW_ELEMENT,
        skipOwned,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        order.push({ node, part });
        if (node.shadowRoot) enter(node.shadowRoot, frame);
        else if (
          descend &&
          (node.localName === "iframe" || node.localName === "frame") &&
          node.namespaceURI === "http://www.w3.org/1999/xhtml"
        ) {
          const shown = rendered(node);
          let child = null;
          if (shown)
            try {
              child = node.contentDocument;
            } catch {}
          const read = !!child && child.defaultView?.origin === location.origin;
          const entry = {
            index: frames.length + 1,
            element: node,
            parent: frame,
            document: read ? child : null,
            origin: read ? location.origin : null,
            reason: read ? null : shown ? "other-origin" : "not-rendered",
          };
          frames.push(entry);
          if (read) enter(child, entry);
        }
      }
    };
    enter(document, null);
    return { parts, frames, order };
  };
  const scan = walk();
  if (command.subaction === "snapshot")
    monitor.updateRoots(scan.parts.map(({ root }) => root));
  const partOf = new Map(scan.parts.map((part) => [part.root, part]));
  const frameOf = (node) => partOf.get(node.getRootNode())?.frame ?? null;
  const readFrame = new Map(
    scan.frames
      .filter((frame) => frame.document)
      .map((frame) => [frame.element, frame]),
  );
  const within = (outer, node) => {
    for (let item = node; item; ) {
      if (item === outer) return true;
      if (item.parentNode) item = item.parentNode;
      else if (item.host) item = item.host;
      else if (item.nodeType === Node.DOCUMENT_NODE && item !== document)
        item = partOf.get(item)?.frame?.element ?? null;
      else item = null;
    }
    return false;
  };
  const boxes = new Map();
  const frameBox = (frame) => {
    if (!frame)
      return {
        x: 0,
        y: 0,
        scale: 1,
        clip: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      };
    if (boxes.has(frame)) return boxes.get(frame);
    const outer = frameBox(frame.parent);
    const element = frame.element;
    const rect = element.getBoundingClientRect();
    const style = styleOf(element);
    const scale =
      outer.scale *
      (element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1);
    const view = frame.document.defaultView;
    const x =
      outer.x +
      rect.x * outer.scale +
      (element.clientLeft + Number.parseFloat(style.paddingLeft || "0")) *
        scale;
    const y =
      outer.y +
      rect.y * outer.scale +
      (element.clientTop + Number.parseFloat(style.paddingTop || "0")) * scale;
    const box = {
      x,
      y,
      scale,
      clip: {
        left: Math.max(outer.clip.left, x),
        top: Math.max(outer.clip.top, y),
        right: Math.min(outer.clip.right, x + view.innerWidth * scale),
        bottom: Math.min(outer.clip.bottom, y + view.innerHeight * scale),
      },
    };
    boxes.set(frame, box);
    return box;
  };
  const bounds = (node) => {
    const rect =
      node === node.ownerDocument.scrollingElement
        ? {
            x: 0,
            y: 0,
            width: realmOf(node).innerWidth,
            height: realmOf(node).innerHeight,
          }
        : node.getBoundingClientRect();
    const frame = frameOf(node);
    if (!frame)
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const box = frameBox(frame);
    return {
      x: box.x + rect.x * box.scale,
      y: box.y + rect.y * box.scale,
      width: rect.width * box.scale,
      height: rect.height * box.scale,
    };
  };
  const scrollState = (node) => {
    const root = node === node.ownerDocument.scrollingElement;
    const style = styleOf(node);
    const width = root ? realmOf(node).innerWidth : node.clientWidth;
    const height = root ? realmOf(node).innerHeight : node.clientHeight;
    const horizontal =
      (root || /^(auto|scroll)$/.test(style.overflowX)) &&
      node.scrollWidth > width;
    const vertical =
      (root || /^(auto|scroll)$/.test(style.overflowY)) &&
      node.scrollHeight > height;
    if (!horizontal && !vertical) return null;
    const rangeX = horizontal ? node.scrollWidth - width : 0;
    return {
      x: node.scrollLeft,
      y: node.scrollTop,
      minX: style.direction === "rtl" ? -rangeX : 0,
      maxX: style.direction === "rtl" ? 0 : rangeX,
      maxY: vertical ? node.scrollHeight - height : 0,
      width,
      height,
      document: root,
    };
  };
  const viewport = () => ({
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    devicePixelRatio,
    scale: visualViewport?.scale ?? 1,
    offsetLeft: visualViewport?.offsetLeft ?? 0,
    offsetTop: visualViewport?.offsetTop ?? 0,
  });
  // Shared by the snapshot and the commit guard so both name a node alike.
  const readVisibleText = (root) => {
    const visibleText = [];
    const collectText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const visibility = node.parentElement
          ? styleOf(node.parentElement).visibility
          : "visible";
        if (
          visibility !== "hidden" &&
          visibility !== "collapse" &&
          node.textContent.trim()
        )
          visibleText.push(node.textContent);
        return;
      }
      if (!is(node, "Element")) return;
      if (
        node.matches("input,textarea,select,script,style,noscript") ||
        node.isContentEditable
      )
        return;
      const style = styleOf(node);
      if (style.display === "none") return;
      if (is(node, "HTMLDetailsElement") && !node.open) {
        const summary = node.querySelector(":scope > summary");
        if (summary) collectText(summary);
        return;
      }
      const assigned =
        node.localName === "slot" && node.getRootNode().host
          ? node.assignedNodes({ flatten: true })
          : [];
      const inner = readFrame.get(node)?.document;
      for (const child of inner
        ? [inner.body ?? inner.documentElement].filter(Boolean)
        : node.shadowRoot
          ? node.shadowRoot.childNodes
          : assigned.length
            ? assigned
            : node.childNodes)
        collectText(child);
    };
    collectText(root);
    return visibleText.join("\n").trim();
  };
  // Accessible name in the usual order. Never reads a form control value
  // except the visible caption of a button-type input.
  const idText = (value, node) => {
    const scope = node.getRootNode();
    return (value || "")
      .split(/\s+/)
      .map((id) => id && scope.getElementById?.(id))
      .filter(Boolean)
      .map((ref) => readVisibleText(ref) || ref.getAttribute("aria-label"))
      .filter(Boolean)
      .join(" ")
      .trim();
  };
  const accessibleName = (node) => {
    const labelled = idText(node.getAttribute("aria-labelledby"), node);
    if (labelled) return labelled;
    const aria = node.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const labels = [...(node.labels ?? [])]
      .map((label) => readVisibleText(label))
      .filter(Boolean)
      .join(" ");
    if (labels) return labels;
    if (
      is(node, "HTMLInputElement") &&
      ["button", "submit", "reset"].includes(node.type)
    )
      return node.value || (node.type === "submit" ? "Submit" : "");
    if (is(node, "HTMLInputElement") && node.type === "image")
      return node.alt || node.title || "";
    if (is(node, "HTMLInputElement") && node.type === "password")
      return node.getAttribute("placeholder") || node.title || "Password";
    if (
      is(node, "HTMLInputElement") ||
      is(node, "HTMLTextAreaElement") ||
      is(node, "HTMLSelectElement") ||
      node.isContentEditable
    )
      return node.getAttribute("placeholder") || node.title || "";
    return readVisibleText(node) || node.title || "";
  };
  const wordsOf = (node) =>
    [
      node.getAttribute("name"),
      node.id,
      node.getAttribute("placeholder"),
      accessibleName(node),
    ]
      .filter(Boolean)
      .join(" ")
      // "routingNumber" and "card_cvv" become separate words.
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_.-]+/g, " ");
  const CARD_WORDS =
    /\b(?:card\s*(?:number|no)|credit\s+card|debit\s+card|cvv2?|cvc|csc|security\s+code|expir(?:y|ation)\s*(?:date)?|cc\s*(?:num|number|exp))\b/i;
  // Marks fields whose value is a secret. The value itself is never read.
  // The field's type and autocomplete tokens decide first. A field that the
  // page does not mark is classified by its name, its id, its placeholder and
  // its accessible name, for example "Social Security number" or
  // "routingNumber". A task never fills such a field and a host never shows
  // it to a model.
  const sensitivity = (node) => {
    if (
      !(
        is(node, "HTMLInputElement") ||
        is(node, "HTMLTextAreaElement") ||
        is(node, "HTMLSelectElement") ||
        node.isContentEditable
      )
    )
      return null;
    const autocomplete = (node.getAttribute("autocomplete") || "")
      .toLowerCase()
      .split(/\s+/);
    if (
      (is(node, "HTMLInputElement") && node.type === "password") ||
      autocomplete.some((token) => token.endsWith("password"))
    )
      return "password";
    if (autocomplete.includes("one-time-code")) return "one-time-code";
    if (autocomplete.some((token) => token.startsWith("cc-")))
      return "payment-card";
    const words = wordsOf(node);
    // "PIN code" is also the Indian postal code: a field that names itself a
    // postal code is an address field, not a password.
    const postal =
      autocomplete.includes("postal-code") ||
      /\b(?:postal|zip|post\s*code)\b/i.test(words);
    if (
      /\b(?:pass\s*(?:word|phrase)|pwd|security\s+answer)\b/i.test(words) ||
      (!postal && /\bpin\b/i.test(words))
    )
      return "password";
    if (CARD_WORDS.test(words)) return "payment-card";
    if (
      /\b(?:one\s*time\s*(?:pass)?code|verification\s+code|otp|2fa|mfa|passcode|authentication\s+code)\b/i.test(
        words,
      )
    )
      return ownerControls(node).some(
        (control) =>
          control !== node &&
          control.matches("input,select,textarea") &&
          (/\bcc-/i.test(control.getAttribute("autocomplete") ?? "") ||
            CARD_WORDS.test(wordsOf(control))),
      )
        ? "payment-card"
        : "one-time-code";
    if (
      /\b(?:routing(?:\s+number)?|iban|swift|bic|sort\s+code|bank\s+account|checking\s+account|savings\s+account)\b/i.test(
        words,
      )
    )
      return "bank-account";
    if (
      /\b(?:ssn|social\s+security|social\s+insurance|tax\s+id(?:entification)?|itin|passport|driver'?s?\s+licen[cs]e|national\s+id|medicare\s+(?:number|id))\b/i.test(
        words,
      )
    )
      return "government-id";
    return null;
  };
  const submitControl = (element) =>
    (is(element, "HTMLButtonElement") && element.type === "submit") ||
    (is(element, "HTMLInputElement") &&
      ["submit", "image"].includes(element.type));
  // The request a submit sends: a submitter's form* attributes override
  // the form's action, method, target and encoding.
  const requestOf = (submitter, form) => {
    const own = (attribute, value, fallback) =>
      submitter?.hasAttribute(attribute) ? value : fallback;
    return {
      action: own("formaction", submitter?.formAction, form.action),
      method: own("formmethod", submitter?.formMethod, form.method),
      target: own(
        "formtarget",
        submitter?.formTarget,
        form.hasAttribute("target")
          ? form.target
          : (form.ownerDocument.querySelector("base[target]")?.target ?? ""),
      ),
      enctype: own("formenctype", submitter?.formEnctype, form.enctype),
    };
  };
  const defaultButton = (form) =>
    [...form.getRootNode().querySelectorAll("button,input")].find(
      (element) => element.form === form && submitControl(element),
    ) ?? null;
  // A control whose effect the browser defines, whatever the page's words.
  // A link to the page it is on (href="#") runs only the page's handlers.
  // A disclosure (a plain button with aria-expanded) or a tab is the page's
  // own claim, not the browser's: a heuristic, since its script may still
  // send something. So it counts only as a button element or a tab that
  // names, with aria-controls, an element in this document; a bare
  // aria-expanded on a div, or a pay button that claims it, does not. A
  // submit button never gets here (it is denied above), and the network
  // watch reports what such a control sends.
  const discloses = (node) =>
    node.matches("button[type=button][aria-expanded],[role=tab]") &&
    (node.getAttribute("aria-controls") ?? "")
      .split(/\s+/)
      .some(
        (id) =>
          id !== "" &&
          (node.getRootNode().getElementById?.(id) ?? null) !== null,
      );
  const inert = (node) => {
    if (
      node.matches("input[type=checkbox],input[type=radio],option,summary") ||
      discloses(node)
    )
      return true;
    if (!is(node, "HTMLAnchorElement") || !node.hasAttribute("href"))
      return false;
    try {
      const target = new URL(node.href);
      const here = new URL(node.ownerDocument.URL);
      target.hash = "";
      here.hash = "";
      return /^https?:$/.test(target.protocol) && target.href !== here.href;
    } catch {
      return false;
    }
  };
  // Only raw payment-credential fields (card/bank numbers) lock non-inert
  // clicks on a document. Displaying currency amounts alone (balances, prices,
  // copays) does not block routine navigation or staging controls.
  const hasPaymentCredentialField = () =>
    scan.parts
      .flatMap(({ root }) => [
        ...root.querySelectorAll("input,textarea,select,[contenteditable]"),
      ])
      .some((field) =>
        ["payment-card", "bank-account"].includes(sensitivity(field)),
      );
  let cachedHasPaymentCredentialField = null;
  const pageHasPaymentCredentialField = () => {
    if (cachedHasPaymentCredentialField === null)
      cachedHasPaymentCredentialField = hasPaymentCredentialField();
    return cachedHasPaymentCredentialField;
  };
  const COMMIT_WORDS_INLINE =
    /\b(?:submit(?:\s+(?:payment|order|form|application|request|claim|message|transfer|bill|now))?|confirm(?:\s+(?:payment|order|appointment|booking|cancellation|transfer|purchase|and\s+pay|&\s*pay|and\s+submit|&\s*submit))?|pay\s+(?:now|today|in\s+full|total|balance|amount|\p{Sc}\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|(?:usd|eur|gbp|cad|aud)\s*\d+(?:[.,]\d+)?)|(?:complete|finalize|authori[sz]e|process|execute)\s+(?:payment|order|purchase|transfer|transaction|checkout|booking|appointment)|place\s+(?:my\s+|your\s+|the\s+)?order|order\s+now|buy\s+now|purchase\s+now|book\s+(?:now|appointment|visit|booking)|reserve\s+now|sign\s*in|sign\s*on|log\s*in|log\s*on|sign\s*up|create\s+(?:an?\s+)?account|register|send(?:\s+(?:message|reply|email|payment|money|transfer|now))?|post\s+(?:comment|reply|message|now)|publish|delete|remove\s+account|close\s+account|cancel\s+(?:service|subscription|membership|plan|order|appointment|booking|payment|account|policy)|authori[sz]e|agree\s+and\b|accept\s+(?:all|and\b|terms|offer|trial)|transfer(?:\s+funds)?|wire(?:\s+funds)?|donate|subscribe|enroll(?:\s+in\b)?|start\s+(?:free\s+)?trial|verify\s+(?:code|identity|account|payment|now))\b|^(?:buy|purchase|verify|check\s*out)$/iu;
  const SAFE_DISMISS_INLINE =
    /^(?:close|dismiss|no,?\s*thanks|not\s+now|maybe\s+later|skip|decline|reject(?:\s+all)?|keep\s+one[- ]?time(?:\s+purchase)?|×|✕|✖|x)$|^close\b|\b(?:strictly\s+)?(?:necessary|essential|required)\s+(?:cookies\s+)?only\b|\b(?:continue|proceed)\s+without\s+(?:accepting|agreeing|enrolling|upgrading|subscribing|autopay|membership|trial|protection)\b/i;
  const DISMISS_AGREES_INLINE =
    /\b(?:accept|agree|allow|consent|ok(?:ay)?|got it|subscribe|sign|log|buy|pay|confirm|enroll|upgrade)\b/i;
  const DECLINE_ESCAPE_INLINE =
    /\b(?:continue|proceed)\s+without\s+(?:accepting|agreeing|enrolling|upgrading|subscribing|autopay|membership|trial|protection)\b/i;
  const SAFE_FORM_STEP_INLINE =
    /^(?:search|find|go|filter|sort|apply|next|continue|back|previous|review(?:\s+[\w& -]+)?|preview|calculate|estimate|add\s+to\s+(?:cart|bag)|update(?:\s+(?:cart|quantity))?|proceed\s+to\s+(?:checkout|payment|review)|pay\s+(?:card|bill|this\s+bill)|make\s+a\s+payment|continue\s+to\s+[\w -]+|save\s+draft)$/i;
  const STAGE_WORDS_INLINE =
    /\b(?:add\s+to\s+(?:cart|bag)|one[- ]?time\s+purchase|standard\s+shipping|free\s+shipping|apply|filter|sort|search|select|update\s+(?:cart|quantity)|save\s+draft|statement\s+balance|minimum\s+(?:payment|due)|current\s+balance|other\s+amount)\b/i;
  const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "ac.uk",
    "com.au",
    "net.au",
    "org.au",
    "gov.au",
    "co.nz",
    "co.jp",
    "ne.jp",
    "or.jp",
    "com.br",
    "com.mx",
    "co.in",
    "com.sg",
    "com.hk",
    "co.za",
    "com.cn",
    "co.kr",
    "com.tw",
  ]);
  const isLoopbackHost = (host) =>
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const registrableSiteOf = (host) => {
    const clean = (host || "").toLowerCase().replace(/\.$/, "");
    if (!clean || /^[\d.]+$/.test(clean) || clean.includes(":")) return null;
    const labels = clean.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    const lastTwo = labels.slice(-2).join(".");
    if (TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo))
      return labels.length >= 3 ? labels.slice(-3).join(".") : null;
    return lastTwo;
  };
  const sameRegistrableSite = (a, b) => {
    const left = (a || "").toLowerCase().replace(/\.$/, "");
    const right = (b || "").toLowerCase().replace(/\.$/, "");
    if (left === right) return true;
    const siteA = registrableSiteOf(left);
    const siteB = registrableSiteOf(right);
    return siteA !== null && siteA === siteB;
  };
  const isValidIsoDate = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !value.startsWith("0000-") &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const parseDateText = (raw, preferMdy = false) => {
    const text = String(raw ?? "").trim();
    if (isValidIsoDate(text)) {
      const [y, m, d] = text.split("-").map(Number);
      return { iso: text, year: y, month: m, day: d };
    }
    const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (slashed) {
      const first = slashed[1].padStart(2, "0");
      const second = slashed[2].padStart(2, "0");
      const year = slashed[3];
      const candidates = preferMdy
        ? [
            { month: first, day: second },
            { month: second, day: first },
          ]
        : [
            { month: second, day: first },
            { month: first, day: second },
          ];
      for (const { month, day } of candidates) {
        const iso = `${year}-${month}-${day}`;
        if (isValidIsoDate(iso))
          return {
            iso,
            year: Number(year),
            month: Number(month),
            day: Number(day),
          };
      }
    }
    return null;
  };
  const classifyNode = (node, subaction = "click", commitPattern = null) => {
    const reasons = [];
    if (subaction === "scroll")
      return { consequence: "observe", reasons: ["scroll"], requiresGrant: false };
    const sens = sensitivity(node);
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") || "").toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();
    if (
      (tag === "input" && type === "password") ||
      ["password", "payment-card", "bank-account", "government-id"].includes(sens)
    )
      return {
        consequence: "commit",
        reasons: ["sensitive-control"],
        requiresGrant: true,
      };
    if (subaction === "fill" || subaction === "select") {
      if (sens === "one-time-code")
        return {
          consequence: "commit",
          reasons: ["verification-code"],
          requiresGrant: true,
        };
      if (tag === "input" && type === "file")
        return {
          consequence: "commit",
          reasons: ["file-upload"],
          requiresGrant: true,
        };
      return {
        consequence: "stage",
        reasons: [subaction],
        requiresGrant: false,
      };
    }
    if (subaction === "follow")
      return {
        consequence: "navigate",
        reasons: ["follow-link"],
        requiresGrant: false,
      };
    const labelText = [
      accessibleName(node),
      node.getAttribute("aria-label"),
      node.textContent,
      node.title,
      is(node, "HTMLInputElement") ? node.value : "",
      ...[...(node.labels ?? [])].map((item) => item.textContent),
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const primaryLabel = (
      accessibleName(node) ||
      node.getAttribute("aria-label") ||
      (is(node, "HTMLInputElement") ? node.value : "") ||
      node.title ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const inDialog =
      node.closest(
        "dialog,[role=dialog],[role=alertdialog],[aria-modal=true]",
      ) !== null;
    const isSafeDismiss =
      SAFE_DISMISS_INLINE.test(primaryLabel) &&
      (DECLINE_ESCAPE_INLINE.test(primaryLabel) ||
        !DISMISS_AGREES_INLINE.test(primaryLabel));
    const form = node.form ?? node.closest("form");
    const formControls = form ? [...form.elements] : [];
    const formHasSensitive = formControls.some((control) =>
      ["password", "payment-card", "bank-account"].includes(
        sensitivity(control),
      ),
    );
    const isSubmits =
      node.matches(
        "button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]",
      ) && (form !== null || tag === "input");
    const hostCommit = !!commitPattern?.test(labelText);
    const wordCommit =
      !isSafeDismiss &&
      !(inDialog && /^cancel$/i.test(primaryLabel)) &&
      COMMIT_WORDS_INLINE.test(labelText);
    const submitCommit =
      isSubmits &&
      (formHasSensitive ||
        wordCommit ||
        hostCommit ||
        !SAFE_FORM_STEP_INLINE.test(primaryLabel));
    const paymentPageLock = pageHasPaymentCredentialField() && !inert(node);
    if (wordCommit) reasons.push("commit-label");
    if (hostCommit) reasons.push("host-commit-pattern");
    if (submitCommit) reasons.push("form-submit");
    if (paymentPageLock) reasons.push("payment-credential-page");
    if (reasons.length > 0)
      return { consequence: "commit", reasons, requiresGrant: true };
    if (
      tag === "summary" ||
      discloses(node) ||
      isSafeDismiss ||
      (inDialog && /^cancel$/i.test(primaryLabel))
    )
      return {
        consequence: "observe",
        reasons: ["disclosure-or-dismiss"],
        requiresGrant: false,
      };
    if (
      tag === "select" ||
      tag === "textarea" ||
      node.isContentEditable ||
      (tag === "input" &&
        !["button", "submit", "reset", "image"].includes(type)) ||
      [
        "checkbox",
        "radio",
        "switch",
        "option",
        "combobox",
        "listbox",
        "radiogroup",
        "spinbutton",
        "slider",
        "textbox",
        "searchbox",
      ].includes(role) ||
      STAGE_WORDS_INLINE.test(primaryLabel)
    )
      return {
        consequence: "stage",
        reasons: ["reversible-stage"],
        requiresGrant: false,
      };
    return {
      consequence: "navigate",
      reasons: ["navigation-or-routine"],
      requiresGrant: false,
    };
  };
  const CODE_BOX_TYPES = ["text", "tel", "number"];
  const CODE_WORDS = /\b(?:code|passcode|otp|one[\s-]*time|verification)\b/i;
  const NOT_A_CODE =
    /\b(?:zip|postal|post\s*code|area\s+code|promo|coupon|gift|referral|discount|voucher|invit(?:e|ation)|card|cvv2?|cvc2?|csc|cvn|cid|security\s+(?:code|answer)|expir(?:y|ation)|pin|pass\s*(?:word|phrase)|pwd|account\s+(?:number|no)|routing|iban|swift|bic|sort\s+code|bank|checking|savings|ssn|social\s+(?:security|insurance)|tax\s+id|itin|passport|driver'?s?\s+licen[cs]e|national\s+id|medicare)\b/i;
  const codeBox = (box) =>
    is(box, "HTMLInputElement") &&
    CODE_BOX_TYPES.includes(box.type) &&
    [null, "one-time-code"].includes(sensitivity(box)) &&
    (box.getAttribute("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .every((token) => ["", "on", "off", "one-time-code"].includes(token)) &&
    !NOT_A_CODE.test(wordsOf(box));
  const ownerControls = (box) =>
    box.form
      ? [...box.form.elements]
      : scan.order
          .map(({ node }) => node)
          .filter(
            (control) =>
              control.matches(
                "button,fieldset,input,object,output,select,textarea",
              ) && control.form === null,
          );
  // The last visible line of text before a control, looked for among its
  // earlier siblings, preceding table cell in the same row, and then its
  // ancestors' earlier siblings. For checkboxes and radios, also falls back to
  // immediately following sibling text when no preceding text exists.
  const precedingCellText = (node) => {
    const cell = node.closest("td,th,[role=cell],[role=gridcell]");
    const row = cell?.closest("tr,[role=row]");
    if (!cell || !row) return null;
    for (
      let prev = cell.previousElementSibling;
      prev;
      prev = prev.previousElementSibling
    ) {
      const text = readVisibleText(prev).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return null;
  };
  const followingSiblingText = (node) => {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (
        is(next, "Element") &&
        next.matches("input,button,select,textarea,[role=button]")
      )
        break;
      const text =
        next.nodeType === Node.TEXT_NODE
          ? next.textContent.replace(/\s+/g, " ").trim()
          : is(next, "Element")
            ? readVisibleText(next).replace(/\s+/g, " ").trim()
            : "";
      if (text) return text;
    }
    return null;
  };
  const nearbyText = (node) => {
    for (
      let item = node, depth = 0;
      item && item !== item.ownerDocument.body && depth < 4;
      item = item.parentElement, depth++
    )
      for (
        let sibling = item.previousSibling;
        sibling;
        sibling = sibling.previousSibling
      ) {
        const text =
          sibling.nodeType === Node.TEXT_NODE
            ? sibling.textContent.trim()
            : is(sibling, "Element")
              ? readVisibleText(sibling)
              : "";
        if (text) return text.split("\n").filter(Boolean).at(-1).trim();
      }
    const cellLabel = precedingCellText(node);
    if (cellLabel) return cellLabel;
    if (
      (is(node, "HTMLInputElement") &&
        ["checkbox", "radio"].includes(node.type)) ||
      ["checkbox", "radio", "switch"].includes(
        (node.getAttribute("role") || "").toLowerCase(),
      )
    )
      return followingSiblingText(node);
    return null;
  };
  const inferredFieldLabel = (node) => {
    if (accessibleName(node)) return null;
    if (
      !(
        is(node, "HTMLInputElement") ||
        is(node, "HTMLTextAreaElement") ||
        is(node, "HTMLSelectElement") ||
        node.isContentEditable ||
        ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch"].includes(
          (node.getAttribute("role") || "").toLowerCase(),
        )
      )
    )
      return null;
    const cell = precedingCellText(node);
    if (cell) return cell.replace(/:$/, "").trim();
    if (
      (is(node, "HTMLInputElement") &&
        ["checkbox", "radio"].includes(node.type)) ||
      ["checkbox", "radio", "switch"].includes(
        (node.getAttribute("role") || "").toLowerCase(),
      )
    ) {
      const after = followingSiblingText(node);
      if (after) return after;
    }
    const near = nearbyText(node);
    return near ? near.replace(/:$/, "").trim() : null;
  };
  const paysHere = (controls) =>
    controls.some((control) =>
      ["payment-card", "bank-account"].includes(sensitivity(control)),
    );
  if (command.subaction === "snapshot") {
    let active = document.activeElement;
    for (let inner = active; inner; ) {
      active = inner;
      inner =
        inner.shadowRoot?.activeElement ??
        readFrame.get(inner)?.document.activeElement ??
        null;
    }
    const controlState = (node) => {
      const flag = (name) => node.getAttribute(name) === "true";
      const current = node.getAttribute("aria-current");
      return {
        focused: document.activeElement === node || active === node,
        disabled: node.matches(":disabled") || flag("aria-disabled"),
        ...(node.readOnly === true || flag("aria-readonly")
          ? { readOnly: true }
          : {}),
        ...(node.isContentEditable ? { contentEditable: true } : {}),
        ...(is(node, "HTMLInputElement") &&
        ["checkbox", "radio"].includes(node.type)
          ? { checked: node.checked }
          : node.hasAttribute("aria-checked")
            ? { checked: flag("aria-checked") }
            : {}),
        ...(node.hasAttribute("aria-expanded")
          ? { expanded: flag("aria-expanded") }
          : {}),
        ...(node.hasAttribute("aria-selected")
          ? { selected: flag("aria-selected") }
          : {}),
        ...(node.hasAttribute("aria-pressed")
          ? { pressed: flag("aria-pressed") }
          : {}),
        ...(current && current !== "false" ? { current } : {}),
        required: node.required === true || flag("aria-required"),
        invalid: flag("aria-invalid"),
        // Field help and error text the page ties to this control.
        description:
          [
            idText(node.getAttribute("aria-describedby"), node),
            flag("aria-invalid")
              ? idText(node.getAttribute("aria-errormessage"), node)
              : "",
          ]
            .filter(Boolean)
            .join(" ") || null,
        sensitive: sensitivity(node),
        ...(is(node, "HTMLInputElement") && node.type === "file"
          ? {
              fileInput: {
                accept: node.getAttribute("accept") || null,
                multiple: node.multiple === true,
                hasFiles: (node.files?.length ?? 0) > 0,
                fileCount: node.files?.length ?? 0,
              },
            }
          : {}),
        ...((is(node, "HTMLInputElement") ||
          is(node, "HTMLSelectElement") ||
          is(node, "HTMLTextAreaElement") ||
          node.isContentEditable) &&
        ((monitor.fromDocumentStart && node.getRootNode() === document) ||
          monitor.editedFields.has(node))
          ? { edited: monitor.editedFields.has(node) }
          : {}),
        // A select can have a valid choice whose internal value is empty.
        // Only selection/occupancy leaves the page, never the field value.
        ...(is(node, "HTMLSelectElement")
          ? {
              hasInput:
                node.selectedIndex >= 0 &&
                !node.validity.valueMissing &&
                !node.options[node.selectedIndex].disabled &&
                (node.value !== "" || monitor.editedFields.has(node)),
            }
          : (is(node, "HTMLInputElement") &&
                ![
                  "button",
                  "submit",
                  "reset",
                  "image",
                  "checkbox",
                  "radio",
                  "file",
                  "hidden",
                  "range",
                  "color",
                ].includes(node.type)) ||
              is(node, "HTMLTextAreaElement")
            ? { hasInput: node.value !== "" }
            : node.isContentEditable
              ? { hasInput: (node.textContent ?? "").trim() !== "" }
              : {}),
      };
    };
    const deepQuery = (root, selector) => {
      const found = [];
      const visit = (scope) => {
        if (!scope || typeof scope.querySelectorAll !== "function") return;
        for (const item of scope.querySelectorAll(selector)) found.push(item);
        for (const el of scope.querySelectorAll("*"))
          if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(root);
      if (root?.shadowRoot) visit(root.shadowRoot);
      return [...new Set(found)];
    };
    const ariaWidgetOptions = (node) => {
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (!["combobox", "listbox", "radiogroup"].includes(role)) return [];
      const scope = node.getRootNode();
      const optionNodes = [];
      const addFrom = (container, selector) => {
        if (!container) return;
        for (const item of deepQuery(container, selector))
          if (!optionNodes.includes(item)) optionNodes.push(item);
      };
      if (role === "radiogroup") {
        addFrom(node, "[role=radio],input[type=radio]");
      } else {
        for (const attr of ["aria-controls", "aria-owns"]) {
          const ids = (node.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
          for (const id of ids) {
            const target =
              scope.getElementById?.(id) ?? document.getElementById(id);
            if (target) addFrom(target, "[role=option]");
          }
        }
        addFrom(node, "[role=option]");
        if (is(node, "HTMLInputElement") && node.list) {
          for (const opt of node.list.options) optionNodes.push(opt);
        }
      }
      return optionNodes.map((opt) => {
        const isRadioInput =
          is(opt, "HTMLInputElement") && opt.type === "radio";
        const isHtmlOption = is(opt, "HTMLOptionElement");
        const label = isHtmlOption
          ? (opt.label || opt.textContent || opt.value || "")
              .replace(/\s+/g, " ")
              .trim()
          : (accessibleName(opt) || opt.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
        return {
          node: opt,
          label,
          value:
            opt.getAttribute?.("data-value") ??
            (typeof opt.value === "string" ? opt.value : null),
          disabled:
            opt.disabled === true ||
            opt.getAttribute?.("aria-disabled") === "true",
          selected: isRadioInput
            ? opt.checked
            : isHtmlOption
              ? opt.selected
              : opt.getAttribute?.("aria-selected") === "true" ||
                opt.getAttribute?.("aria-checked") === "true",
        };
      });
    };
    // A page can copy what was typed in a secret field into its own text, its
    // title or a control's name. The values are compared here, in the page, and
    // every copy is replaced before anything is returned. Very short values are
    // not compared: they would match ordinary words.
    const secrets = [
      ...new Set(
        scan.parts
          .flatMap(({ root }) => [...root.querySelectorAll("input,textarea")])
          .filter((node) => sensitivity(node) !== null)
          .map((node) => node.value)
          .filter((value) => typeof value === "string" && value.length >= 4),
      ),
    ].sort((left, right) => right.length - left.length);
    for (const code of monitor.heldCodes ?? [])
      if (code.until > Date.now() && !secrets.includes(code.text))
        secrets.push(code.text);
    secrets.sort((left, right) => right.length - left.length);
    const withoutSecrets = (value) =>
      typeof value === "string"
        ? secrets.reduce(
            (text, secret) => text.split(secret).join("[hidden]"),
            value,
          )
        : value;
    const nodes = new Map();
    const elements = [];
    // Native controls and widget roles, as assistive technology lists them.
    const NATIVE =
      "a,button,input,textarea,select,summary,[contenteditable=true],[contenteditable=''],[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=listbox],[role=radiogroup],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=spinbutton],[role=slider]";
    // A page can also make a plain element pressable with an inline click
    // handler, a tab stop or a pointer cursor, often with no name at all.
    // The commit guard treats the same signals as a control. Only the
    // outermost such element that holds no native control is listed.
    // One pass in document order. The cheap attribute test runs before the
    // style and subtree tests, and an element inside a listed custom control
    // is skipped by its ancestor, so a large page stays linear.
    const custom = new Set();
    const candidates = [];
    if (document.scrollingElement && scrollState(document.scrollingElement))
      candidates.push(document.scrollingElement);
    for (const { node, frameRoot } of scan.order) {
      if (frameRoot) {
        if (scrollState(node)) candidates.push(node);
        continue;
      }
      if (node.matches(NATIVE)) {
        candidates.push(node);
        continue;
      }
      const scrollable = scrollState(node) !== null;
      if (
        !(
          node.matches('[onclick],[tabindex]:not([tabindex="-1"])') ||
          (styleOf(node).cursor === "pointer" &&
            styleOf(node.parentElement ?? node).cursor !== "pointer")
        ) ||
        node.closest(NATIVE) ||
        node.querySelector(NATIVE)
      ) {
        if (scrollable) candidates.push(node);
        continue;
      }
      let inside = false;
      for (
        let item = node.parentElement;
        item && !inside;
        item = item.parentElement
      )
        inside = custom.has(item);
      if (inside) {
        if (scrollable) candidates.push(node);
        continue;
      }
      custom.add(node);
      candidates.push(node);
    }
    // The form or field group the control belongs to, by its own name.
    const groupName = (group) =>
      group
        ? idText(group.getAttribute("aria-labelledby"), group) ||
          group.getAttribute("aria-label")?.trim() ||
          (group.querySelector("legend,h1,h2,h3,h4,h5,h6")
            ? readVisibleText(group.querySelector("legend,h1,h2,h3,h4,h5,h6"))
            : "") ||
          null
        : null;
    const forms = scan.parts.flatMap(({ root }) => [
      ...root.querySelectorAll("form"),
    ]);
    const semanticForm = '[role~="form" i]';
    const ownedRegions = scan.parts.flatMap(({ root }) =>
      [...root.querySelectorAll(`form[aria-owns],${semanticForm}[aria-owns]`)]
        .flatMap((form) => form.getAttribute("aria-owns").trim().split(/\s+/))
        .map((id) => root.getElementById(id))
        .filter((element) => element !== null),
    );
    // Position of an element among its siblings with the same tag, counted
    // once per parent.
    const typeIndexes = new Map();
    const typeIndex = (item) => {
      if (!typeIndexes.has(item)) {
        const counts = {};
        for (const sibling of item.parentNode?.children ?? [item]) {
          counts[sibling.tagName] = (counts[sibling.tagName] ?? 0) + 1;
          typeIndexes.set(sibling, counts[sibling.tagName]);
        }
      }
      return typeIndexes.get(item);
    };
    // A CSS selector that matches only this node now. A host may grant one
    // task action on it after the person agrees; the page guard checks the
    // match again at the moment of the action.
    const uniqueSelector = (node) => {
      const scope = node.getRootNode();
      const own = localSelector(node, scope);
      if (own === null || scope === document) return own;
      const via = scope.host ?? partOf.get(scope)?.frame?.element;
      const outer = via ? uniqueSelector(via) : null;
      const selector = outer === null ? null : `${outer} >>> ${own}`;
      return selector !== null && selector.length <= 256 ? selector : null;
    };
    const localSelector = (node, scope) => {
      if (node === scope.documentElement) return "html";
      const unique = (selector) => {
        try {
          return (
            selector.length <= 256 &&
            scope.querySelectorAll(selector).length === 1 &&
            scope.querySelector(selector) === node
          );
        } catch {
          return false;
        }
      };
      if (node.id && unique(`#${CSS.escape(node.id)}`))
        return `#${CSS.escape(node.id)}`;
      const name = node.getAttribute("name");
      const named =
        name && `${node.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (named && unique(named)) return named;
      // A child-combinator path of :nth-of-type steps from a unique id or
      // from the root names one element. It is not searched for again here:
      // the page guard checks that it matches only this node at the moment
      // of a granted action.
      const path = [];
      let anchoredById = false;
      for (
        let item = node;
        item && item !== scope.documentElement;
        item = item.parentElement
      ) {
        if (item !== node && item.id && unique(`#${CSS.escape(item.id)}`)) {
          path.unshift(`#${CSS.escape(item.id)}`);
          anchoredById = true;
          break;
        }
        path.unshift(
          `${item.tagName.toLowerCase()}:nth-of-type(${typeIndex(item)})`,
        );
      }
      if (
        scope.nodeType !== Node.DOCUMENT_NODE &&
        !anchoredById &&
        path.length > 0
      ) {
        const topTag = path[0].split(":")[0];
        path[0] = `${path[0]}:not(* ${topTag})`;
      }
      const selector = path.join(" > ");
      try {
        return selector.length <= 256 &&
          (scope.nodeType === Node.DOCUMENT_NODE
            ? node.matches(selector)
            : unique(selector))
          ? selector
          : null;
      } catch {
        return null;
      }
    };
    const sendsOf = (submitter, form) => {
      const { action, method, target } = requestOf(submitter, form);
      if (method === "dialog")
        return { origin: null, method, newWindow: false };
      const origin = (() => {
        try {
          const url = new URL(action, form.baseURI);
          return /^https?:$/.test(url.protocol) ? url.origin : null;
        } catch {
          return null;
        }
      })();
      return {
        origin,
        method,
        newWindow: !["", "_self", "_parent", "_top"].includes(
          target.toLowerCase(),
        ),
      };
    };
    const implicitSends = new Map();
    const formSends = (form) => {
      if (!implicitSends.has(form)) {
        const button = defaultButton(form);
        implicitSends.set(
          form,
          button?.matches(":disabled") ||
            (!button &&
              [...form.elements].filter(
                (field) =>
                  is(field, "HTMLInputElement") &&
                  [
                    "text",
                    "search",
                    "url",
                    "tel",
                    "email",
                    "password",
                    "date",
                    "month",
                    "week",
                    "time",
                    "datetime-local",
                    "number",
                  ].includes(field.type),
              ).length > 1)
            ? null
            : sendsOf(button, form),
        );
      }
      return implicitSends.get(form);
    };
    for (const node of candidates) {
      if (!node.checkVisibility({ checkVisibilityCSS: true })) continue;
      const id = String(nodes.size);
      const geometry = bounds(node);
      const scroll = scrollState(node);
      const scrollOnly = !!scroll && !node.matches(NATIVE) && !custom.has(node);
      // This equality sentinel never leaves the isolated page realm.
      nodes.set(id, {
        node,
        bounds: geometry,
        href: is(node, "HTMLAnchorElement") ? node.href : null,
        scroll,
        scrollOnly,
        value: node.isContentEditable
          ? (node.textContent ?? "")
          : typeof node.value === "string"
            ? node.value
            : null,
        selection: is(node, "HTMLSelectElement") ? node.selectedIndex : null,
      });
      const state = controlState(node);
      const form = node.form ?? node.closest("form");
      const landmark = node.closest(semanticForm);
      const semanticOwner =
        (landmark !== null && !is(landmark, "HTMLFormElement")) ||
        ownedRegions.some((region) => region.contains(node));
      // A button that sends its form when pressed.
      const submits = submitControl(node) && node.form !== null;
      const hint = (value) => withoutSecrets(value?.trim() || null);
      const frame = frameOf(node);
      const widgetOptions =
        !is(node, "HTMLSelectElement") && sensitivity(node) === null
          ? ariaWidgetOptions(node)
          : [];
      const selectedOptionLabel =
        is(node, "HTMLSelectElement") &&
        sensitivity(node) === null &&
        node.selectedIndex >= 0
          ? hint(
              node.options[node.selectedIndex]?.label.replace(/\s+/g, " ") ??
                "",
            )
          : widgetOptions.length > 0
            ? hint(widgetOptions.find((opt) => opt.selected)?.label ?? "")
            : null;
      const consequence = scrollOnly
        ? "observe"
        : classifyNode(node, "click").consequence;
      elements.push({
        bounds: geometry,
        id,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        label: withoutSecrets(
          scrollOnly
            ? scroll.document
              ? frame
                ? frame.element.title.trim() || "Frame"
                : "Page"
              : groupName(node) || "Scrollable region"
            : accessibleName(node),
        ),
        ...(scroll ? { scroll, scrollOnly } : {}),
        type: node.getAttribute("type"),
        consequence,
        ...state,
        description: withoutSecrets(state.description),
        // Option labels are page-authored choices, not internal option values.
        ...(is(node, "HTMLSelectElement") && sensitivity(node) === null
          ? {
              options: [...node.options].map((option) => ({
                label: hint(option.label.replace(/\s+/g, " ")),
                disabled:
                  option.disabled || option.parentElement?.disabled === true,
                selected: option.selected,
              })),
            }
          : widgetOptions.length > 0
            ? {
                options: widgetOptions.map((option) => ({
                  label: hint(option.label),
                  disabled: option.disabled,
                  selected: option.selected,
                })),
              }
            : {}),
        ...(selectedOptionLabel ? { selectedLabel: selectedOptionLabel } : {}),
        // Words that locate a control when its name is empty or repeated.
        // None of them is a field value.
        placeholder: hint(node.getAttribute("placeholder")),
        title: hint(node.getAttribute("title")),
        fieldName: hint(node.getAttribute("name")),
        imageText: hint(
          [...node.querySelectorAll("img[alt],svg title")]
            .map((item) => item.getAttribute("alt") ?? item.textContent)
            .join(" "),
        ),
        nearbyText: hint(nearbyText(node)),
        ...(inferredFieldLabel(node)
          ? { inferredLabel: hint(inferredFieldLabel(node)) }
          : {}),
        // The whole row or list item a control sits in, cell by cell, such
        // as "The Overstory | Due October 20" beside an unnamed Renew icon.
        rowText: hint(
          (() => {
            const row = node.closest("tr,[role=row],li,[role=listitem]");
            return row
              ? readVisibleText(row).split("\n").filter(Boolean).join(" | ")
              : null;
          })(),
        ),
        form: semanticOwner
          ? { index: -1, name: null, sends: form ? formSends(form) : null }
          : form
            ? {
                index: forms.indexOf(form),
                name: hint(groupName(form)),
                sends: formSends(form),
              }
            : null,
        group: hint(groupName(node.closest("fieldset,[role=group]"))),
        submits,
        sends: submits ? sendsOf(node, node.form) : null,
        pressable: custom.has(node)
          ? node.matches("[onclick]")
            ? "click-handler"
            : node.matches("[tabindex]")
              ? "tab-stop"
              : "pointer-cursor"
          : null,
        inViewport:
          geometry.width > 0 &&
          geometry.height > 0 &&
          geometry.x < innerWidth &&
          geometry.y < innerHeight &&
          geometry.x + geometry.width > 0 &&
          geometry.y + geometry.height > 0 &&
          (!frame ||
            (geometry.x < frameBox(frame).clip.right &&
              geometry.y < frameBox(frame).clip.bottom &&
              geometry.x + geometry.width > frameBox(frame).clip.left &&
              geometry.y + geometry.height > frameBox(frame).clip.top)),
        targetSelector: uniqueSelector(node),
        heading: node.querySelector("h1,h2,h3,h4,h5,h6")
          ? withoutSecrets(
              readVisibleText(node.querySelector("h1,h2,h3,h4,h5,h6")),
            )
          : null,
        href:
          is(node, "HTMLAnchorElement") && /^https?:/.test(node.href)
            ? node.href
            : null,
        ...(frame
          ? {
              frame: {
                index: frame.index,
                origin: frame.origin,
                title: hint(frame.element.title),
              },
            }
          : {}),
        ...(node.getRootNode().host ? { inShadowRoot: true } : {}),
      });
    }
    const pageText = readVisibleText(document.body ?? document.documentElement);
    // What stands between the person and the page: a modal, a cookie or
    // consent banner, a person check (CAPTCHA), a sign-in wall or a paywall.
    // These are reported, never answered. Nothing here presses a control, and
    // a person check has no ref at all: only the person can do it. `ref` is a
    // control that closes the blocker without agreeing to anything; for a
    // consent banner only the reject or necessary-only control is offered, as
    // `rejectRef`. `covers` says what it takes: most of the viewport, the
    // centre of a listed control outside it, or only part of the page.
    const blockers = (() => {
      const idOf = new Map([...nodes].map(([id, entry]) => [entry.node, id]));
      const labelOf = new Map(
        elements.map((element) => [element.id, element.label ?? ""]),
      );
      const inner = scan.parts.filter(({ root }) => root !== document);
      const queryAll = (selector, root = document) => [
        ...(root === document ? [] : root.matches(selector) ? [root] : []),
        ...root.querySelectorAll(selector),
        ...inner
          .filter((part) => within(root, part.root.host ?? part.frame.element))
          .flatMap((part) => [...part.root.querySelectorAll(selector)]),
      ];
      const up = (item) =>
        item.parentElement ??
        item.parentNode?.host ??
        partOf.get(item.parentNode)?.frame?.element ??
        null;
      const owned = (node) => {
        for (let item = node; item; item = up(item))
          if (monitor.ownedHosts.has(item)) return true;
        return false;
      };
      const visible = (node) =>
        node.checkVisibility({ checkVisibilityCSS: true }) &&
        node.getBoundingClientRect().width > 0 &&
        node.getBoundingClientRect().height > 0;
      const textOf = (node) =>
        withoutSecrets(readVisibleText(node).replace(/\s+/g, " ").trim());
      // A fixed layer that holds almost all of the page is the site's own
      // frame, not something in front of the page.
      const shells = new Map();
      const shell = (node) => {
        if (!shells.has(node))
          shells.set(
            node,
            pageText.length - readVisibleText(node).length < 40 &&
              !elements.some(
                (element) =>
                  !element.scrollOnly &&
                  !within(node, nodes.get(element.id).node),
              ),
          );
        return shells.get(node);
      };
      // The outermost fixed layer a node sits in, below any site frame.
      const layerOf = (node) => {
        let layer = null;
        for (
          let item = node;
          item && item !== document.body && item !== document.documentElement;
          item = up(item)
        )
          if (styleOf(item).position === "fixed" && !shell(item)) layer = item;
        return layer;
      };
      const hitAt = (x, y) => {
        let hit = document.elementFromPoint(x, y);
        let local = [x, y];
        while (hit && !owned(hit)) {
          const frame = readFrame.get(hit);
          if (frame) {
            const box = frameBox(frame);
            local = [(x - box.x) / box.scale, (y - box.y) / box.scale];
          }
          const deeper = frame
            ? frame.document.elementFromPoint(...local)
            : hit.shadowRoot?.elementFromPoint(...local);
          if (!deeper || deeper === hit) break;
          hit = deeper;
        }
        return hit;
      };
      const GRID = 9;
      const hits = [];
      for (let row = 0; row < GRID; row++)
        for (let column = 0; column < GRID; column++) {
          const hit = hitAt(
            ((column + 0.5) * innerWidth) / GRID,
            ((row + 0.5) * innerHeight) / GRID,
          );
          if (hit && !owned(hit)) hits.push(hit);
        }
      const share = (root) =>
        hits.filter((hit) => within(root, hit)).length / (GRID * GRID);
      const layered = (node) => {
        try {
          if (node.matches(":modal")) return true;
        } catch {}
        for (
          let item = node;
          item &&
          item !== item.ownerDocument.body &&
          item !== item.ownerDocument.documentElement;
          item = item.parentElement ?? item.parentNode?.host ?? null
        )
          if (
            ["fixed", "absolute", "sticky"].includes(styleOf(item).position) &&
            !shell(item)
          )
            return true;
        return false;
      };
      const DIALOG =
        "dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]";
      const CONSENT =
        "#onetrust-banner-sdk,#onetrust-consent-sdk,#CybotCookiebotDialog,#usercentrics-root,#truste-consent-track,#didomi-host,#qc-cmp2-container,.qc-cmp2-container,#cookie-law-info-bar,.cc-window,.cky-consent-container,#cmpbox,[id^=sp_message_container],[aria-label*=cookie i],[id*=cookie-banner i],[class*=cookie-banner i],[id*=cookie-consent i],[class*=cookie-consent i],[id*=cookieconsent i],[class*=cookieconsent i],[id*=consent-banner i],[class*=consent-banner i]";
      const CAPTCHA =
        'iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="challenges.cloudflare.com" i],iframe[title*="captcha" i],iframe[title*="security challenge" i],.g-recaptcha,.h-captcha,.cf-turnstile,#cf-turnstile,#challenge-form,#challenge-stage,[data-hcaptcha-widget-id]';
      const PAYWALL = "[id*=paywall i],[class*=paywall i]";
      const CAPTCHA_TEXT =
        /\b(?:verify(?:ing)? (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|are you a robot|human verification|confirm you(?:'re| are) (?:a )?human|press (?:and|&) hold|complete the security check|checking (?:if the site connection is secure|your browser))/i;
      const LOGIN_TEXT =
        /\b(?:(?:sign|log) ?in (?:to|now to) (?:continue|view|see|read|access|keep reading|proceed)|(?:sign|log) ?in (?:is )?required|you (?:must|need to) (?:be )?(?:signed|logged) ?in|please (?:sign|log) ?in\b|create (?:a |an )?(?:free )?account to (?:continue|view|see|read|keep reading))/i;
      const PAYWALL_TEXT =
        /\b(?:subscribe (?:now |today )?to (?:continue|keep reading|read|unlock)|(?:reached|used) (?:your|all(?: of)? your) (?:\w+ )?(?:free )?(?:articles?|stories|story)|free (?:articles?|stories) (?:remaining|left)|(?:this|the rest of this) (?:article|story|content) is (?:only )?(?:for|available to|exclusive to|reserved for) (?:paid )?(?:subscribers|members)|unlock (?:this|the full) (?:article|story)|become a (?:member|subscriber) to (?:continue|read))/i;
      const CONSENT_TEXT =
        /\b(?:cookies?|consent|privacy (?:choices|preferences|settings)|tracking technologies)\b/i;
      const REJECT =
        /^(?:reject|decline|refuse|deny|disagree)(?: all| optional| non-essential| additional| unnecessary)?(?: cookies)?$|\b(?:strictly )?(?:necessary|essential|required) (?:cookies )?only\b|\bonly (?:allow |accept |use )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?\b|\bcontinue without (?:accepting|agreeing)\b|\breject all\b/i;
      const CLOSE =
        /^(?:close|dismiss|no,?\s*thanks|not\s+now|maybe\s+later|skip|decline|keep\s+one[- ]?time(?:\s+purchase)?|×|✕|✖|x)$|^close\b|\b(?:continue|proceed)\s+without\s+(?:accepting|agreeing|enrolling|upgrading|subscribing|autopay|membership|trial|protection)\b/i;
      // A "Close and accept" or "Dismiss and continue" control agrees to
      // something; it is never offered as the way out. Explicit "continue
      // without enrolling/accepting" declines without agreeing.
      const AGREES =
        /\b(?:accept|agree|allow|consent|ok(?:ay)?|got it|continue|subscribe|sign|log|buy|pay|confirm|enroll|upgrade)\b/i;
      const hasVisiblePassword = (root = document) =>
        queryAll("input[type=password]", root).some(
          (node) => node !== root && visible(node),
        );
      const hasSignOutControl =
        !hasVisiblePassword(document) &&
        elements.some(
          (element) =>
            !element.scrollOnly &&
            ["a", "button"].includes(element.tag) &&
            /^(?:sign\s*out|log\s*out|logout)$/i.test(
              (element.label ?? "").trim(),
            ),
        );
      // An invisible reCAPTCHA or hCaptcha is bound to a page's own button
      // and is not in the way until the site shows a challenge. Its frame's
      // address says size=invisible.
      const captchas = queryAll(CAPTCHA).filter(
        (node) =>
          !node.matches(
            'button,input,a,[data-size=invisible],iframe[src*="size=invisible" i]',
          ) &&
          !node.closest(".grecaptcha-badge") &&
          !owned(node) &&
          visible(node),
      );
      const roots = new Map();
      const add = (root, found) => {
        if (root && !roots.has(root) && !owned(root)) roots.set(root, found);
      };
      for (const hit of hits) add(layerOf(hit), { overlay: true });
      // A "Cookie settings" link in the footer is not a banner.
      for (const node of [...queryAll(`${DIALOG},${CONSENT}`), ...captchas])
        if (
          visible(node) &&
          !node.matches(
            "a,button,input,select,textarea,[role=button],[role=link]",
          )
        ) {
          const layer = layerOf(node);
          add(layer ?? node, { overlay: !!layer || layered(node) });
        }
      // A sign-in wall, paywall or person check written into the page itself.
      const texts = [];
      for (const { root } of scan.parts) {
        const doc = root.ownerDocument ?? root;
        const start = root === doc ? (doc.body ?? doc.documentElement) : root;
        if (!start) continue;
        const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode())
          texts.push(text);
      }
      const privateInvitation =
        /^(?:sign|log) ?in (?:to|now to) (?:view|see|read|access|manage|pay)(?: and (?:view|see|read|access|manage|pay))? your\b/i;
      const unavailableAncestry =
        `${DIALOG},form,[inert],[aria-hidden=true],[aria-disabled=true]`;
      const scopedInvitation = (root, overlay, words) => {
        if (
          overlay ||
          !privateInvitation.test(words) ||
          !root.matches("section,article,aside") ||
          root.closest(unavailableAncestry) ||
          queryAll(`${DIALOG},form,input,textarea,select`, root).length ||
          /\b(?:sign|log) ?in (?:(?:now )?to (?:continue|proceed|keep reading)|(?:is )?required)\b|\byou (?:must|need to) (?:be )?(?:signed|logged) ?in\b/i.test(textOf(root))
        )
          return false;
        const main = root.parentElement?.closest("main,[role=main]");
        if (!main || main.closest(unavailableAncestry)) return false;
        const location = root.ownerDocument.location;
        return [...nodes.values()].some(({ node, bounds: box, scrollOnly }) => {
          if (
            scrollOnly ||
            !node.matches("a[href]") ||
            !within(main, node) ||
            within(root, node) ||
            node.closest(`${unavailableAncestry},header,footer,nav,[role=navigation]`) ||
            !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            !node.textContent.trim() ||
            !["http:", "https:"].includes(node.protocol) ||
            node.origin !== location.origin ||
            (node.pathname === location.pathname && node.search === location.search)
          )
            return false;
          const region = node.closest("section,article,aside");
          if (!region || within(region, root)) return false;
          const hit = hitAt(box.x + box.width / 2, box.y + box.height / 2);
          return !!hit && within(node, hit);
        });
      };
      const inline = new Set();
      for (const text of texts) {
        const parent = text.parentElement;
        const words = text.textContent.replace(/\s+/g, " ");
        const kind = CAPTCHA_TEXT.test(words)
          ? "captcha"
          : LOGIN_TEXT.test(words)
            ? "login-wall"
            : PAYWALL_TEXT.test(words)
              ? "paywall"
              : null;
        if (
          !kind ||
          inline.has(kind) ||
          !parent ||
          parent.closest("script,style,noscript,template") ||
          owned(parent) ||
          !visible(parent)
        )
          continue;
        const root =
          parent.closest(
            `${DIALOG},form,section,article,aside,main,[role=main]`,
          ) ?? parent;
        const layer = layerOf(root);
        const overlay = !!layer || layered(root);
        if (
          kind === "login-wall" &&
          !overlay &&
          !hasVisiblePassword(root) &&
          (hasSignOutControl ||
            parent.closest("footer,nav,[role=navigation]") !== null)
        )
          continue;
        const scoped = kind === "login-wall" && scopedInvitation(root, overlay, words.trim());
        if (!scoped) inline.add(kind);
        add(layer ?? root, { overlay, kind, text: words.trim(), scoped });
      }
      const result = [];
      for (const [root, found] of roots) {
        // One report per blocker: an inner element of another is part of it.
        if (
          [...roots.keys()].some(
            (other) => other !== root && within(other, root),
          )
        )
          continue;
        const has = (selector) => queryAll(selector, root).length > 0;
        const text = textOf(root);
        const dialog = has(DIALOG);
        const kind =
          found.kind === "captcha" ||
          captchas.some((node) => within(root, node)) ||
          CAPTCHA_TEXT.test(text)
            ? "captcha"
            : has(CONSENT)
              ? "cookie-consent"
              : found.kind === "login-wall" ||
                  queryAll("input[type=password]", root)
                    .filter((node) => node !== root)
                    .some(visible) ||
                  LOGIN_TEXT.test(text)
                ? "login-wall"
                : found.kind === "paywall" ||
                    has(PAYWALL) ||
                    PAYWALL_TEXT.test(text)
                  ? "paywall"
                  : found.overlay && CONSENT_TEXT.test(text)
                    ? "cookie-consent"
                    : dialog || (found.overlay && share(root) >= 0.25)
                      ? "modal"
                      : null;
        if (!kind) continue;
        let covers = "partial";
        let modal = false;
        try {
          modal =
            root.matches("dialog:modal") ||
            !!root.querySelector("dialog:modal");
        } catch {}
        const scoped = kind === "login-wall" && found.scoped === true;
        if (modal || (!scoped && share(root) >= 0.5)) covers = "viewport";
        else if (
          !scoped &&
          !found.overlay &&
          kind !== "modal" &&
          kind !== "cookie-consent" &&
          pageText.length - readVisibleText(root).length < 300
        )
          // The page is little more than this wall: an interstitial.
          covers = "viewport";
        else if (
          [...nodes.values()].some(({ node, bounds: box, scrollOnly }) => {
            if (scrollOnly || within(root, node) || within(node, root))
              return false;
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
              return false;
            const hit = hitAt(x, y);
            return !!hit && within(root, hit);
          })
        )
          covers = "target";
        const control = (pattern) => {
          for (const [node, id] of idOf) {
            const candidate = (labelOf.get(id) ?? "").trim();
            if (
              within(root, node) &&
              node !== root &&
              pattern.test(candidate) &&
              (pattern === REJECT ||
                DECLINE_ESCAPE_INLINE.test(candidate) ||
                !AGREES.test(candidate))
            )
              return id;
          }
          return undefined;
        };
        const ref =
          kind === "captcha" || kind === "cookie-consent"
            ? undefined
            : control(CLOSE);
        const rejectRef =
          kind === "cookie-consent" ? control(REJECT) : undefined;
        // Hide secrets before cutting: a cut can split a secret, and "[hidden]" can
        // be longer than the value it replaces.
        const summary = (
          found.text === undefined ? text : withoutSecrets(found.text)
        ).slice(0, 200);
        result.push({
          kind,
          ...(ref !== undefined ? { ref } : {}),
          ...(rejectRef !== undefined ? { rejectRef } : {}),
          covers,
          overlay: found.overlay,
          ...(summary ? { text: summary } : {}),
        });
      }
      const rank = { viewport: 0, target: 1, partial: 2 };
      return result.sort(
        (left, right) => rank[left.covers] - rank[right.covers],
      );
    })();
    store[key] = {
      snapshotId,
      nodes,
      document,
      url: location.href,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
      descend,
      parts: scan.parts.map(({ root }) => root),
      frameUrls: scan.frames.map((frame) => frame.document?.URL ?? null),
    };
    // A submit or page change that a task fill or click set off in this
    // document, under this binding. The watch below stopped it.
    const violation = store[watchKey]?.violation;
    // The commit the person said yes to, which the watch let through once.
    const consented = store[watchKey]?.consented;
    // A one-shot comparison from the actual fill, kept in this isolated realm.
    // Neither the expected text nor the field value leaves the page.
    const inputReadback = monitor.inputReadback;
    delete monitor.inputReadback;
    const statementRegions = () => {
      const incomplete = { complete: false, regions: [] };
      if (
        policy ||
        window !== window.top ||
        document.readyState !== "complete" ||
        blockers.some(({ kind, covers, overlay }) =>
          kind === "captcha" || covers !== "partial" ||
          (overlay && ["login-wall", "modal", "paywall"].includes(kind)),
        ) ||
        elements.some(({ tag, type, role, sensitive, edited, focused, hasInput }) =>
          sensitive || hasInput || edited || tag === "textarea" || role === "textbox" ||
          (tag !== "input" && tag !== "select" && edited !== undefined) ||
          (tag === "input" &&
            !(["hidden", "submit", "button", "reset", "checkbox", "radio", "image"].includes(type) ||
              ((type === "search" || role === "searchbox") && !focused))),
        )
      ) return incomplete;

      const areas = document.querySelectorAll('main,[role="main"]');
      if (areas.length > 1) return incomplete;
      const scope = areas[0] ?? document.body;
      const excluded =
        'nav,aside,footer,form,input,textarea,select,button,iframe,frame,object,embed,script,style,template,noscript,[contenteditable],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[hidden],[aria-hidden="true"],[inert]';
      const interactive = 'a,[role="link"],[role="button"]';
      const labelExcluded = excluded + "," + interactive;
      if (!scope || scope.closest(excluded + ",header")) return incomplete;
      for (let ancestor = scope.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = styleOf(ancestor);
        if (style.display === "none" || style.opacity === "0") return incomplete;
      }

      const groups = new Map();
      const ownersByNode = new WeakMap();
      const owners = new Map();
      const headingSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
      const startsSection = (node, region) =>
        node.matches('article,[role="article"],[role="region"]') ||
        (node.matches("section") &&
          (!region || node.hasAttribute("aria-label") ||
            node.hasAttribute("aria-labelledby") ||
            node.querySelector(`:scope > :is(${headingSelector}), :scope > header :is(${headingSelector})`)));
      const startsRow = (node) => {
        if (!is(node, "HTMLTableRowElement") || !node.cells.length) return false;
        const header = node.closest("table")?.tHead?.rows[0]?.cells;
        return header?.length > 1 && node.cells[0].localName === "td" &&
          Array.from(header).every((cell) => cell.localName === "th");
      };
      let visited = 0;
      let fragments = 0;
      let characters = 0;
      let previousRun;
      const visit = (node, key, region, line, depth, insideHeader) => {
        if (++visited > 4096 || depth > 40) return false;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          if (!region || !text || styleOf(node.parentElement).visibility !== "visible") return true;
          characters += text.length;
          if (characters > 24576 || ++fragments > 1024) return false;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (!range.getClientRects().length) return true;
          if (!groups.has(region)) groups.set(region, []);
          if (groups.size > 128) return false;
          const runs = groups.get(region);
          const run = region + ":" + line;
          if (run === previousRun) runs[runs.length - 1] += text;
          else runs.push(text);
          previousRun = run;
          return true;
        }
        if (!is(node, "Element") || node.matches(excluded)) return true;
        if (insideHeader && node.matches(interactive)) {
          previousRun = undefined;
          return true;
        }
        if (node.localName === "header" &&
            !owners.get(region)?.node.matches('article,section,[role="article"],[role="region"]')) return true;
        const inHeader = insideHeader || node.localName === "header";
        const style = styleOf(node);
        if (style.display === "none" || style.opacity === "0") return true;
        if (
          node !== scope &&
          (startsSection(node, region) ||
            (node.parentElement === scope && node.matches("p,dl,table,ol,ul")) ||
            startsRow(node))
        ) {
          const owner = { node, parent: region, headings: [] };
          ownersByNode.set(node, owner);
          owners.set(key, owner);
          region = key;
        }
        if (style.display !== "contents" && !style.display.startsWith("inline")) line = key;
        if (node.localName === "br") previousRun = undefined;
        if (is(node, "HTMLDetailsElement") && !node.open) {
          const summary = node.querySelector(":scope > summary");
          return summary === null || visit(summary, key + ".summary", region, line, depth + 1, inHeader);
        }
        let index = 0;
        for (const child of node.childNodes) {
          const childKey = child.nodeType === Node.ELEMENT_NODE ? key + "." + index++ : key;
          if (!visit(child, childKey, region, line, depth + 1, inHeader)) return false;
        }
        return true;
      };
      if (!visit(scope, "main", undefined, "main", 0, false)) return incomplete;
      const ownerOf = (node) => {
        for (let parent = node.parentElement; parent && parent !== scope; parent = parent.parentElement) {
          const owner = ownersByNode.get(parent);
          if (owner) return owner;
        }
      };
      let labelNodes = 0;
      const visibleLabel = (root) => {
        if (!root || !scope.contains(root) || root.closest(labelExcluded)) return undefined;
        const header = root.closest("header");
        if (header && scope === document.body && !ownerOf(header)) return undefined;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let text = "";
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (++labelNodes > 1024) return null;
          const parent = node.parentElement;
          if (!parent || parent.closest(labelExcluded) ||
              !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (!range.getClientRects().length) continue;
          text += node.textContent;
          if (text.length > 192) return null;
        }
        return withoutSecrets(text.replace(/\s+/gu, " ").trim()) || undefined;
      };
      const primary = [];
      const headings = scope.querySelectorAll(headingSelector);
      if (headings.length > 256) return incomplete;
      for (const node of headings) {
        const level = /^h[1-6]$/u.test(node.localName)
          ? Number(node.localName[1]) : Number(node.getAttribute("aria-level") ?? 2);
        if (level < 1 || level > 6 || !Number.isInteger(level)) continue;
        const owner = ownerOf(node);
        if (!owner && level !== 1) continue;
        const text = visibleLabel(node);
        if (text !== undefined) (owner?.headings ?? primary).push({ level, text });
      }
      const headingOf = (headings) => {
        const level = Math.min(...headings.map((heading) => heading.level));
        const choices = [...new Set(headings.filter((heading) => heading.level === level).map((heading) => heading.text))];
        return choices.length > 1 ? null : choices[0];
      };
      const authorLabelOf = (owner) => {
        const ids = owner.node.getAttribute("aria-labelledby")?.trim().split(/\s+/gu) ?? [];
        if (ids.length > 4 || ids.some((id) => id.length > 128)) return null;
        const labels = [];
        for (const id of new Set(ids.filter(Boolean))) {
          const nodes = document.querySelectorAll("#" + CSS.escape(id));
          if (nodes.length > 1) return null;
          const label = visibleLabel(nodes[0]);
          if (label === null) return null;
          if (label) labels.push(label);
        }
        return labels.length > 1 ? null : labels[0];
      };
      const primaryHeading = headingOf(primary);
      if (primaryHeading === null) return incomplete;
      const readings = new Map();
      const readOwner = (key) => {
        if (readings.has(key)) return readings.get(key);
        const owner = owners.get(key);
        const heading = headingOf(owner.headings);
        const authorLabel = authorLabelOf(owner);
        const enclosing = owner.parent === undefined ? {} : readOwner(owner.parent);
        const ancestorLabels = [...new Set([enclosing.heading, enclosing.authorLabel, ...(enclosing.ancestorLabels ?? [])].filter(Boolean))];
        const result = {
          ...(heading && { heading }),
          ...(authorLabel && { authorLabel }),
          ...(ancestorLabels.length <= 8 && ancestorLabels.length > 0 && { ancestorLabels }),
          ...((heading === null || authorLabel === null || enclosing.ambiguous || ancestorLabels.length > 8) && { ambiguous: true }),
        };
        readings.set(key, result);
        return result;
      };
      const tableColumns = new WeakMap();
      const tableRowOf = (key) => {
        const { node, parent: parentKey } = owners.get(key);
        const parent = owners.get(parentKey)?.node;
        if (!startsRow(node) || !parent ||
            !parent.matches('article,section,[role="article"],[role="region"]') ||
            readOwner(key).ambiguous || !groups.has(parentKey)) return undefined;
        const table = node.closest("table");
        if (table.parentElement.closest('article,section,[role="article"],[role="region"]') !== parent ||
            table.parentElement.closest("table") ||
            table.closest(excluded + ",header") ||
            table.matches("[aria-label],[aria-labelledby],[role]")) return undefined;
        const visibleCell = (cell) => cell.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          cell.getClientRects().length > 0 && cell.colSpan === 1 && cell.rowSpan === 1;
        if (!tableColumns.has(table)) {
          const head = table.tHead;
          const headers = Array.from(head.rows[0].cells);
          const simple = headers.length <= 8 && head.rows.length === 1 &&
            !table.caption && table.tBodies.length === 1 &&
            !table.querySelector(labelExcluded + ",table,tbody th,tfoot th,[tabindex],[onclick]") &&
            !Array.from(table.querySelectorAll("td[rowspan]")).some((cell) => cell.rowSpan !== 1) &&
            headers.every((cell) => visibleCell(cell) && (!cell.scope || cell.scope === "col"));
          const columns = simple ? headers.map(visibleLabel) : [];
          tableColumns.set(table, columns.length && columns.every(Boolean) &&
            new Set(columns.map((column) => column.toLowerCase())).size === columns.length ? columns : undefined);
        }
        const columns = tableColumns.get(table);
        if (!columns || !node.matches("tbody > tr,tfoot > tr") ||
            node.cells.length !== columns.length ||
            !Array.from(node.cells).every((cell) => cell.localName === "td" && visibleCell(cell) &&
              !cell.hasAttribute("headers") && !cell.hasAttribute("scope"))) return undefined;
        return { parentKey, columns };
      };
      let metadataSize = primaryHeading?.length ?? 0;
      const regions = [...groups].flatMap(([key, runs]) => {
        const fragments = runs.map((run) => withoutSecrets(run.trim())).filter(Boolean);
        if (!fragments.length) return [];
        const metadata = readOwner(key);
        metadataSize += (metadata.heading?.length ?? 0) + (metadata.authorLabel?.length ?? 0) +
          (metadata.ancestorLabels ?? []).reduce((size, label) => size + label.length, 0);
        const tableRow = tableRowOf(key);
        if (tableRow) metadataSize += tableRow.parentKey.length +
          tableRow.columns.reduce((size, column) => size + column.length, 0);
        return [{ key, fragments, ...metadata, ...(tableRow && { tableRow }) }];
      });
      if (metadataSize > 8192 || labelNodes > 1024) return incomplete;
      const emitted = new Set(regions.map(({ key }) => key));
      for (const region of regions) {
        if (region.tableRow && !emitted.has(region.tableRow.parentKey)) delete region.tableRow;
      }
      return { complete: true, ...(primaryHeading && { primaryHeading }), regions };
    };
    const structuredRegions = () => {
      const idOfNode = new Map([...nodes].map(([id, entry]) => [entry.node, id]));
      const elById = new Map(elements.map((el) => [el.id, el]));
      const clean = (value, maxLen = 240) => {
        const text = withoutSecrets(
          String(value ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        );
        return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
      };
      const isShown = (node) => {
        try {
          return (
            node.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            }) &&
            node.getBoundingClientRect().width > 0 &&
            node.getBoundingClientRect().height > 0
          );
        } catch {
          return false;
        }
      };
      const frameIndexOf = (node) => frameOf(node)?.index ?? null;
      const inShadowOf = (node) => Boolean(node.getRootNode()?.host);
      const headingSel = "h1,h2,h3,h4,h5,h6,[role=heading]";
      const firstHeadingIn = (container) => {
        const found = deepQuery(container, headingSel).find(isShown);
        return found ? clean(readVisibleText(found), 160) || null : null;
      };
      const actionRefsIn = (container, limit = 16) => {
        const refs = [];
        for (const [node, id] of idOfNode) {
          if (refs.length >= limit) break;
          const el = elById.get(id);
          if (!el || el.scrollOnly) continue;
          if (within(container, node)) refs.push(id);
        }
        return refs;
      };
      const headings = [];
      let pageHeading = null;
      for (const { root } of scan.parts) {
        for (const node of root.querySelectorAll(headingSel)) {
          if (headings.length >= 64) break;
          if (!isShown(node)) continue;
          const text = clean(readVisibleText(node), 160);
          if (!text) continue;
          const level = /^h[1-6]$/i.test(node.localName)
            ? Number(node.localName[1])
            : Number(node.getAttribute("aria-level") ?? 2);
          const entry = {
            level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2,
            text,
            ...(inShadowOf(node) ? { inShadowRoot: true } : {}),
            ...(frameIndexOf(node) !== null
              ? { frameIndex: frameIndexOf(node) }
              : {}),
          };
          if (pageHeading === null && entry.level === 1) pageHeading = text;
          headings.push(entry);
        }
      }
      const landmarkSel =
        "header,nav,main,aside,footer,dialog[open],[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo],[role=region],[role=dialog],[role=alertdialog],section[aria-label],section[aria-labelledby],form";
      const landmarks = [];
      for (const { root } of scan.parts) {
        for (const node of root.querySelectorAll(landmarkSel)) {
          if (landmarks.length >= 40) break;
          if (!isShown(node)) continue;
          const role =
            node.getAttribute("role") ||
            {
              header: "banner",
              nav: "navigation",
              main: "main",
              aside: "complementary",
              footer: "contentinfo",
              dialog: "dialog",
              section: "region",
              form: "form",
            }[node.localName] ||
            node.localName;
          const label =
            clean(
              idText(node.getAttribute("aria-labelledby"), node) ||
                node.getAttribute("aria-label") ||
                "",
              120,
            ) || null;
          const heading = firstHeadingIn(node);
          const textPreview = clean(readVisibleText(node), 220);
          if (!label && !heading && !textPreview) continue;
          landmarks.push({
            regionId: `landmark-${landmarks.length}`,
            role,
            label,
            heading,
            textPreview,
            actionRefs: actionRefsIn(node, 12),
            ...(inShadowOf(node) ? { inShadowRoot: true } : {}),
            ...(frameIndexOf(node) !== null
              ? { frameIndex: frameIndexOf(node) }
              : {}),
          });
        }
      }
      const tables = [];
      for (const { root } of scan.parts) {
        for (const table of root.querySelectorAll(
          "table,[role=table],[role=grid]",
        )) {
          if (tables.length >= 16) break;
          if (!isShown(table)) continue;
          const isHtmlTable = is(table, "HTMLTableElement");
          const caption = isHtmlTable && table.caption
            ? clean(readVisibleText(table.caption), 120) || null
            : clean(
                idText(table.getAttribute("aria-labelledby"), table) ||
                  table.getAttribute("aria-label") ||
                  "",
                120,
              ) || null;
          const containerHeading =
            table.closest("section,article,main,[role=region]")
              ? firstHeadingIn(
                  table.closest("section,article,main,[role=region]"),
                )
              : null;
          let columns = [];
          const rows = [];
          let totalRows = 0;
          if (isHtmlTable) {
            const headRow =
              table.tHead?.rows[0] ??
              [...table.rows].find((r) =>
                [...r.cells].every((c) => c.localName === "th"),
              );
            if (headRow)
              columns = [...headRow.cells]
                .filter(isShown)
                .map((c) => clean(readVisibleText(c), 80));
            const bodyRows = [...table.rows].filter((r) => r !== headRow);
            totalRows = bodyRows.length;
            for (const r of bodyRows) {
              if (rows.length >= 40) break;
              if (!isShown(r)) continue;
              const cells = [...r.cells]
                .filter(isShown)
                .map((c) => clean(readVisibleText(c), 120));
              const actionRefs = actionRefsIn(r, 8);
              if (cells.some(Boolean) || actionRefs.length > 0)
                rows.push({ cells, actionRefs });
            }
          } else {
            const headerCells = [
              ...table.querySelectorAll("[role=columnheader]"),
            ].filter(isShown);
            columns = headerCells.map((c) => clean(readVisibleText(c), 80));
            const roleRows = [...table.querySelectorAll("[role=row]")].filter(
              (r) =>
                isShown(r) && r.querySelector("[role=cell],[role=gridcell]"),
            );
            totalRows = roleRows.length;
            for (const r of roleRows) {
              if (rows.length >= 40) break;
              const cells = [
                ...r.querySelectorAll("[role=cell],[role=gridcell]"),
              ]
                .filter(isShown)
                .map((c) => clean(readVisibleText(c), 120));
              const actionRefs = actionRefsIn(r, 8);
              if (cells.some(Boolean) || actionRefs.length > 0)
                rows.push({ cells, actionRefs });
            }
          }
          if (columns.length > 0 || rows.length > 0) {
            tables.push({
              regionId: `table-${tables.length}`,
              caption,
              heading: containerHeading,
              columns,
              rows,
              rowCount: totalRows,
              ...(inShadowOf(table) ? { inShadowRoot: true } : {}),
              ...(frameIndexOf(table) !== null
                ? { frameIndex: frameIndexOf(table) }
                : {}),
            });
          }
        }
      }
      const SPONSORED_BADGE =
        /^(?:sponsored|promoted|ad|advertisement|paid\s+partnership|featured\s+ad)$/i;
      const OPTIN_TRAP =
        /\b(?:auto[- ]?pay|automatic\s+pay(?:ment)?s?|paperless|subscribe|subscription|membership|free\s+trial|protection\s+plan|warranty|marketing|promotional|newsletter|special\s+offers?|text\s+alerts?|upgrade|add[- ]?on)\b/i;
      const RECURRING_TRAP =
        /\b(?:subscribe\s*(?:&|and)\s*save|auto[- ]?deliver|recurring|monthly\s+plan|subscription|auto[- ]?renew)\b/i;
      const ONETIME_ALT =
        /\b(?:one[- ]?time|single\s+purchase|standard\s+purchase|pay\s+once)\b/i;
      const PAID_ADDON_TRAP =
        /\b(?:express|priority|rush|overnight|same[- ]?day|expedited|convenience\s+fee|service\s+fee|card\s+fee|surcharge)\b/i;
      const FREE_ALT =
        /\b(?:standard|free|no\s+fee|bank\s+account|ach|checking|\$0(?:\.00)?)\b/i;
      const UPSELL_MODAL =
        /\b(?:auto[- ]?pay|automatic\s+pay|free\s+trial|upgrade|protection\s+plan|subscribe|membership|paperless|special\s+offer|add\s+protection|save\s+with\s+membership|try\s+(?:free\s+)?(?:membership|plus|pro))\b/i;
      const CONFIRMSHAMING =
        /\b(?:no,?\s*thanks.*(?:pay\s+full|don'?t\s+want\s+to\s+save|miss\s+out|lose\s+my)|i\s+prefer\s+to\s+pay\s+more)\b/i;
      const darkPatterns = [];
      const seenTraps = new Set();
      const pushTrap = (trap) => {
        const sig = `${trap.kind}:${trap.ref ?? ""}:${trap.text.slice(0, 60)}`;
        if (seenTraps.has(sig) || darkPatterns.length >= 32) return;
        seenTraps.add(sig);
        darkPatterns.push(trap);
      };
      const cards = [];
      const cardNodes = [];
      const cardSel =
        "article,[role=article],li,[role=listitem],section,fieldset,[role=group]";
      for (const { root } of scan.parts) {
        for (const node of root.querySelectorAll(cardSel)) {
          if (cards.length >= 48) break;
          if (!isShown(node)) continue;
          if (node.closest("nav,[role=navigation],header,footer")) continue;
          const heading = firstHeadingIn(node);
          const actionRefs = actionRefsIn(node, 10);
          const rawLines = readVisibleText(node)
            .split("\n")
            .map((line) => clean(line, 160))
            .filter(Boolean);
          if (rawLines.length === 0) continue;
          if (!heading && actionRefs.length === 0 && rawLines.length < 2)
            continue;
          // Skip giant outer wrappers that contain multiple sub-cards already
          const childCardCount = [
            ...node.querySelectorAll("article,[role=article],li,[role=listitem]"),
          ].filter((c) => c !== node && isShown(c)).length;
          if (childCardCount >= 2) continue;
          const badges = [];
          for (const badgeNode of deepQuery(
            node,
            "span,small,mark,strong,em,p,div,[aria-label]",
          )) {
            if (badges.length >= 6) break;
            if (!isShown(badgeNode)) continue;
            const aria = (badgeNode.getAttribute("aria-label") || "").trim();
            const ownText =
              badgeNode.childElementCount === 0
                ? (badgeNode.textContent || "").replace(/\s+/g, " ").trim()
                : "";
            const candidate = SPONSORED_BADGE.test(ownText)
              ? ownText
              : SPONSORED_BADGE.test(aria)
                ? aria
                : ownText.length > 0 &&
                    ownText.length <= 24 &&
                    /\b(?:sponsored|promoted|ad|pending|past\s+due|overdue|abnormal|out\s+of\s+stock|subscribe|autopay)\b/i.test(
                      ownText,
                    )
                  ? ownText
                  : "";
            if (candidate && !badges.includes(candidate))
              badges.push(clean(candidate, 40));
          }
          const cardTraps = [];
          if (badges.some((b) => SPONSORED_BADGE.test(b))) {
            cardTraps.push("sponsored-listing");
            pushTrap({
              kind: "sponsored-listing",
              ...(actionRefs[0] ? { ref: actionRefs[0] } : {}),
              label: heading ?? rawLines[0] ?? null,
              text: clean(rawLines.slice(0, 3).join(" | "), 180),
            });
          }
          cardNodes.push(node);
          cards.push({
            regionId: `card-${cards.length}`,
            heading,
            textLines: rawLines.slice(0, 8),
            badges,
            actionRefs,
            ...(cardTraps.length > 0 ? { darkPatterns: cardTraps } : {}),
            ...(inShadowOf(node) ? { inShadowRoot: true } : {}),
            ...(frameIndexOf(node) !== null
              ? { frameIndex: frameIndexOf(node) }
              : {}),
          });
        }
      }
      // Inspect checkboxes, switches, and radio groups for pre-checked opt-ins & recurring/paid defaults.
      const radioGroups = new Map();
      for (const [node, id] of idOfNode) {
        const el = elById.get(id);
        if (!el || el.scrollOnly) continue;
        const role = (el.role || "").toLowerCase();
        const combined = [el.label, el.inferredLabel, el.nearbyText, el.group, el.rowText]
          .filter(Boolean)
          .join(" ");
        if (CONFIRMSHAMING.test(el.label || "")) {
          pushTrap({
            kind: "confirmshaming",
            ref: id,
            targetSelector: el.targetSelector,
            label: el.label,
            text: clean(el.label, 160),
          });
        }
        const isCheckbox =
          (el.tag === "input" && el.type === "checkbox") ||
          role === "checkbox" ||
          role === "switch";
        if (
          isCheckbox &&
          el.checked === true &&
          !monitor.editedFields.has(node) &&
          OPTIN_TRAP.test(combined)
        ) {
          pushTrap({
            kind: "pre-checked-opt-in",
            ref: id,
            targetSelector: el.targetSelector,
            label: el.label || el.inferredLabel || el.nearbyText,
            text: clean(combined, 180),
          });
        }
        const isRadio =
          (el.tag === "input" && el.type === "radio") || role === "radio";
        if (isRadio) {
          const groupKey =
            (is(node, "HTMLInputElement") && node.name
              ? `name:${node.getRootNode() === document ? "doc" : "sub"}:${node.name}`
              : null) ??
            (node.closest("[role=radiogroup],fieldset,form")
              ? `group:${elements.indexOf(el) >= 0 ? (el.group ?? "anon") : "anon"}`
              : "default");
          if (!radioGroups.has(groupKey)) radioGroups.set(groupKey, []);
          radioGroups.get(groupKey).push({ node, id, el, combined });
        }
      }
      for (const items of radioGroups.values()) {
        const checked = items.find(
          ({ node, el }) => el.checked === true && !monitor.editedFields.has(node),
        );
        if (!checked) continue;
        if (
          RECURRING_TRAP.test(checked.combined) &&
          items.some((other) => other !== checked && ONETIME_ALT.test(other.combined))
        ) {
          pushTrap({
            kind: "recurring-default",
            ref: checked.id,
            targetSelector: checked.el.targetSelector,
            label: checked.el.label || checked.el.inferredLabel || checked.el.nearbyText,
            text: clean(checked.combined, 180),
          });
        }
        if (
          PAID_ADDON_TRAP.test(checked.combined) &&
          items.some((other) => other !== checked && FREE_ALT.test(other.combined))
        ) {
          pushTrap({
            kind: "paid-default-addon",
            ref: checked.id,
            targetSelector: checked.el.targetSelector,
            label: checked.el.label || checked.el.inferredLabel || checked.el.nearbyText,
            text: clean(checked.combined, 180),
          });
        }
      }
      for (const blocker of blockers) {
        if (
          blocker.kind === "modal" &&
          blocker.text &&
          UPSELL_MODAL.test(blocker.text)
        ) {
          pushTrap({
            kind: "upsell-modal",
            ...(blocker.ref ? { dismissRef: blocker.ref } : {}),
            text: clean(blocker.text, 180),
          });
        }
      }
      const structuredForms = [];
      for (const { root } of scan.parts) {
        for (const form of root.querySelectorAll("form,[role=form]")) {
          if (structuredForms.length >= 20) break;
          if (!isShown(form)) continue;
          const controls = deepQuery(
            form,
            "input,select,textarea,button,[contenteditable=true],[role=combobox],[role=textbox],[role=button]",
          );
          const fieldRefs = [];
          const submitRefs = [];
          let hasPassword = false;
          let hasPaymentCredential = false;
          let hasOtp = false;
          let hasFileInput = false;
          for (const control of controls) {
            const sens = sensitivity(control);
            if (sens === "password") hasPassword = true;
            if (sens === "payment-card" || sens === "bank-account")
              hasPaymentCredential = true;
            if (sens === "one-time-code") hasOtp = true;
            if (is(control, "HTMLInputElement") && control.type === "file")
              hasFileInput = true;
            const id = idOfNode.get(control);
            if (!id) continue;
            if (submitControl(control)) submitRefs.push(id);
            else if (
              is(control, "HTMLInputElement") ||
              is(control, "HTMLSelectElement") ||
              is(control, "HTMLTextAreaElement") ||
              control.isContentEditable ||
              ["combobox", "textbox", "searchbox"].includes(
                (control.getAttribute("role") || "").toLowerCase(),
              )
            )
              fieldRefs.push(id);
          }
          structuredForms.push({
            formIndex: structuredForms.length,
            name: clean(groupName(form) || "", 120) || null,
            hasPassword,
            hasPaymentCredential,
            hasOtp,
            hasFileInput,
            fieldRefs: fieldRefs.slice(0, 32),
            submitRefs: submitRefs.slice(0, 8),
          });
        }
      }
      const fileInputs = [];
      for (const { root } of scan.parts) {
        for (const input of root.querySelectorAll("input[type=file]")) {
          if (fileInputs.length >= 16) break;
          const ref = idOfNode.get(input) ?? null;
          let triggerRef = ref;
          if (triggerRef === null) {
            for (const label of input.labels ?? []) {
              const id = idOfNode.get(label);
              if (id) {
                triggerRef = id;
                break;
              }
            }
          }
          if (triggerRef === null) {
            const container = input.parentElement;
            if (container) {
              for (const candidate of container.querySelectorAll(
                "button,label,[role=button]",
              )) {
                const id = idOfNode.get(candidate);
                if (id) {
                  triggerRef = id;
                  break;
                }
              }
            }
          }
          const label =
            clean(
              accessibleName(input) ||
                inferredFieldLabel(input) ||
                [...(input.labels ?? [])]
                  .map((l) => readVisibleText(l))
                  .join(" ") ||
                "",
              120,
            ) || "File upload";
          fileInputs.push({
            ref,
            triggerRef,
            targetSelector: uniqueSelector(input),
            label,
            accept: input.getAttribute("accept") || null,
            multiple: input.multiple === true,
            hasFiles: (input.files?.length ?? 0) > 0,
            fileCount: input.files?.length ?? 0,
            hiddenInput: ref === null,
          });
        }
      }
      return {
        complete: true,
        pageHeading,
        landmarks,
        headings,
        tables,
        cards,
        forms: structuredForms,
        fileInputs,
        darkPatterns,
      };
    };
    const clickReadback = monitor.clickReadback;
    delete monitor.clickReadback;
    const codeReadback = monitor.codeReadback;
    delete monitor.codeReadback;
    const formatted =
      !!inputReadback &&
      inputReadback.node.isConnected &&
      !sensitivity(inputReadback.node) &&
      is(inputReadback.node, "HTMLInputElement") &&
      ["text", "tel"].includes(inputReadback.node.type) &&
      inputReadback.node.value !== inputReadback.text &&
      ((/^\d{2,32}$/.test(inputReadback.text) &&
        /^[\d(][\d ()/-]*$/.test(inputReadback.node.value) &&
        inputReadback.node.value.replace(/[ ()/-]/g, "") ===
          inputReadback.text) ||
        (() => {
          const preferMdy = (
            inputReadback.node.getAttribute("placeholder") || ""
          )
            .toLowerCase()
            .includes("mm/dd/yyyy");
          const a = parseDateText(inputReadback.text, preferMdy);
          const b = parseDateText(inputReadback.node.value, preferMdy);
          return a !== null && b !== null && a.iso === b.iso;
        })());
    return {
      ...(policy &&
      clickReadback &&
      clickReadback.scope === policy.guidanceScope
        ? {
            clickReadback: {
              targetRef: clickReadback.targetRef,
              synchronousTextChange:
                clickReadback.before !== clickReadback.after &&
                clickReadback.after === pageText,
            },
          }
        : {}),
      ...(policy &&
      inputReadback &&
      inputReadback.scope === policy.guidanceScope
        ? {
            inputReadback: {
              targetRef: inputReadback.targetRef,
              matches:
                inputReadback.node.isConnected &&
                !sensitivity(inputReadback.node) &&
                ((inputReadback.node.isContentEditable
                  ? (inputReadback.node.textContent ?? "") === inputReadback.text
                  : inputReadback.node.value === inputReadback.text) ||
                  formatted),
              ...(formatted ? { formatted: true } : {}),
            },
          }
        : {}),
      ...(policy &&
      codeReadback &&
      codeReadback.scope === policy.guidanceScope &&
      codeReadback.until > Date.now()
        ? {
            codeReadback: {
              targetRef: codeReadback.targetRef,
              boxes: codeReadback.nodes.length,
              matches: codeReadback.nodes.every(
                (box, index) =>
                  box.isConnected &&
                  [null, "one-time-code"].includes(sensitivity(box)) &&
                  box.value === codeReadback.parts[index],
              ),
            },
          }
        : {}),
      ...(policy && violation && violation.scope === policy.guidanceScope
        ? { effectViolation: violation.kind }
        : {}),
      // For the browser host's network watch only; it never reaches a host.
      ...(policy && store[watchKey]?.scope === policy.guidanceScope
        ? {
            watchHandoff: handoffOf(store[watchKey]),
          }
        : {}),
      ...(policy && consented && consented.scope === policy.guidanceScope
        ? {
            consentedCommit: {
              grantId: consented.grantId,
              kind: consented.kind,
              ...(consented.formHash ? { formHash: consented.formHash } : {}),
            },
          }
        : {}),
      url: location.href,
      title: withoutSecrets(document.title),
      // The language the page declares, so a host knows which words it can read.
      lang: /^[a-z]{2,3}(?:-[a-z0-9]{1,8}){0,4}$/.test(
        document.documentElement.lang.trim().toLowerCase(),
      )
        ? document.documentElement.lang.trim().toLowerCase()
        : null,
      readyState: document.readyState,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
      text: command.statementRegions === true ? "" : withoutSecrets(pageText),
      ...(command.statementRegions === true && { statementRegions: statementRegions() }),
      ...(command.structuredRegions === true && {
        structuredRegions: structuredRegions(),
      }),
      blockers,
      ...(descend
        ? {
            childFrames: scan.frames.map((frame) => ({
              index: frame.index,
              read: frame.document !== null,
              ...(frame.reason ? { reason: frame.reason } : {}),
              origin: frame.origin,
              parent: frame.parent?.index ?? null,
              title: withoutSecrets(frame.element.title.trim() || null),
              bounds: bounds(frame.element),
            })),
          }
        : {}),
      complete: true,
      omitted: [
        "form control values and editable region contents (credential boundary)",
        "page text, title and control names equal to the value of a password, code or card field",
        ...(scan.frames.some((frame) => frame.reason === "other-origin")
          ? ["the contents of frames on another origin (childFrames)"]
          : []),
        ...(scan.frames.some((frame) => frame.reason === "not-rendered")
          ? ["frames the page does not show (childFrames)"]
          : []),
      ],
      elements,
    };
  }
  const state = store[key];
  if (
    !state ||
    state.snapshotId !== command.snapshotId ||
    state.document !== document ||
    state.url !== location.href ||
    state.domRevision !== monitor.domRevision ||
    state.inputRevision !== monitor.inputRevision ||
    JSON.stringify(state.viewport) !== JSON.stringify(viewport()) ||
    !Array.isArray(state.parts) ||
    state.parts.length !== scan.parts.length ||
    state.parts.some((root, index) => root !== scan.parts[index].root) ||
    JSON.stringify(state.frameUrls) !==
      JSON.stringify(scan.frames.map((frame) => frame.document?.URL ?? null))
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "Read a fresh snapshot of this tab.",
      },
    };
  const recorded = state.nodes.get(command.nodeId);
  const node = recorded?.node;
  if (
    !node?.isConnected ||
    !partOf.has(node.getRootNode()) ||
    recorded.value !==
      (node.isContentEditable
        ? (node.textContent ?? "")
        : typeof node.value === "string"
          ? node.value
          : null) ||
    recorded.selection !==
      (is(node, "HTMLSelectElement") ? node.selectedIndex : null) ||
    JSON.stringify(recorded.bounds) !== JSON.stringify(bounds(node)) ||
    JSON.stringify(recorded.scroll) !== JSON.stringify(scrollState(node))
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "The referenced page element changed; read a fresh snapshot.",
      },
    };
  if (recorded.scrollOnly && command.subaction !== "scroll") return denied();
  if (command.subaction === "scroll") {
    const scroll = scrollState(node);
    if (
      !scroll ||
      !{
        up: scroll.y > 0,
        down: scroll.y < scroll.maxY,
        left: scroll.x > scroll.minX,
        right: scroll.x < scroll.maxX,
      }[command.direction]
    )
      return denied();
  }
  let codeBoxes = null;
  const named = (selector) => {
    let scope = document;
    const steps = selector.split(" >>> ");
    for (let index = 0; ; index++) {
      const matches = scope.querySelectorAll(steps[index]);
      if (matches.length !== 1) return null;
      if (index === steps.length - 1) return matches[0];
      const inner =
        matches[0].shadowRoot ?? readFrame.get(matches[0])?.document ?? null;
      if (!inner || !partOf.has(inner)) return null;
      scope = inner;
    }
  };
  const codeGroup = () => {
    const controls = ownerControls(node);
    const runs = [];
    let run = null;
    for (const control of controls) {
      if (
        !(
          is(control, "HTMLInputElement") &&
          control.maxLength === 1 &&
          CODE_BOX_TYPES.includes(control.type) &&
          control.ownerDocument === node.ownerDocument
        )
      ) {
        run = null;
        continue;
      }
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(control);
    }
    const boxes = runs.length === 1 ? runs[0] : [];
    const seen = new Map(
      [...state.nodes.values()].map((entry) => [entry.node, entry]),
    );
    const group = node.closest("fieldset,[role=group]");
    const legend = group?.querySelector("legend");
    const groupWords = group
      ? [
          idText(group.getAttribute("aria-labelledby"), group),
          group.getAttribute("aria-label"),
          legend ? readVisibleText(legend) : "",
        ].join(" ")
      : "";
    const reviewed = (box) =>
      policy.targets.some((target) => {
        if (target.action !== "fill-code") return false;
        try {
          return named(target.selector) === box;
        } catch {
          return false;
        }
      });
    const near = nearbyText(node) ?? "";
    return boxes[0] === node &&
      boxes.length === command.text.length &&
      !paysHere(controls) &&
      CODE_WORDS.test([wordsOf(node), groupWords, near].join(" ")) &&
      !NOT_A_CODE.test([groupWords, near].join(" ")) &&
      boxes.every(
        (box, index) =>
          codeBox(box) &&
          !box.disabled &&
          !box.readOnly &&
          box.value === "" &&
          seen.get(box)?.value === "" &&
          JSON.stringify(seen.get(box).bounds) ===
            JSON.stringify(bounds(box)) &&
          (box.type !== "number" || /^\d$/.test(command.text[index])) &&
          (index === 0 || reviewed(box)),
      )
      ? boxes
      : null;
  };
  const codeTargets = () => {
    if (
      !is(node, "HTMLInputElement") ||
      !/^[A-Za-z0-9]{4,12}$/.test(command.text)
    )
      return null;
    if (node.maxLength === 1) return grant ? codeGroup() : null;
    const near = nearbyText(node) ?? "";
    return (node.autocomplete === "one-time-code" ||
      (grant && CODE_WORDS.test([wordsOf(node), near].join(" ")))) &&
      codeBox(node) &&
      !NOT_A_CODE.test(near) &&
      (node.type !== "number" || /^\d+$/.test(command.text)) &&
      !paysHere(ownerControls(node))
      ? [node]
      : null;
  };
  let clickedConsequence = "navigate";
  if (policy) {
    // The native host supplies reviewed target permissions; DOM text cannot
    // grant an action. Re-check the actual node immediately before the effect.
    if (
      !policy.targets.some((target) => {
        // A host can bind one action to the one reviewed control it chose.
        if (
          policy.expectedSelector !== undefined &&
          target.selector !== policy.expectedSelector
        )
          return false;
        const permission =
          command.subaction === "fill" &&
          policy.protectedValueKind === "verification-code"
            ? "fill-code"
            : command.subaction;
        if (target.action !== permission) return false;
        try {
          return named(target.selector) === node;
        } catch {
          return false;
        }
      })
    )
      return denied();
    // The host's own commit words, for the languages it serves (bounded and
    // checked by the binding). They only add to COMMIT_CONTROL.
    let commitPattern = null;
    if (policy.commitPattern !== undefined)
      try {
        commitPattern = new RegExp(policy.commitPattern, "iu");
      } catch {
        return denied();
      }
    // Tiered action consequence classification: observe | navigate | stage | commit.
    // True irreversible commitments and raw payment-credential pages always
    // require a single-use commitGrant; routine wizard navigation and reversible
    // staging steps on pages merely displaying currency amounts are permitted up
    // to policy.maxConsequence (default "stage").
    const tierRank = { observe: 0, navigate: 1, stage: 2, commit: 3 };
    const maxTier = ["observe", "navigate", "stage"].includes(
      policy.maxConsequence,
    )
      ? policy.maxConsequence
      : "stage";
    if (command.subaction === "click") {
      const classified = classifyNode(node, "click", commitPattern);
      clickedConsequence = classified.consequence;
      if (
        !grant &&
        (classified.consequence === "commit" ||
          tierRank[classified.consequence] > tierRank[maxTier])
      )
        return denied();
    }
    if (
      command.subaction === "fill" &&
      policy.protectedValueKind === "verification-code"
    )
      codeBoxes = codeTargets();
    if (
      command.subaction === "fill" &&
      is(node, "HTMLInputElement") &&
      node.type === "file"
    )
      return {
        error: {
          kind: "POLICY_BLOCKED",
          reason: "file-upload-requires-host-picker",
          message:
            "File uploads must be chosen by the person through the host file picker.",
          accept: node.getAttribute("accept") || null,
          multiple: node.multiple === true,
        },
      };
    if (
      command.subaction === "fill" &&
      (!(
        is(node, "HTMLInputElement") ||
        is(node, "HTMLTextAreaElement") ||
        is(node, "HTMLSelectElement") ||
        node.isContentEditable
      ) ||
        (is(node, "HTMLInputElement") &&
          !["text", "email", "tel", "number", "search", "url", "date"].includes(
            node.type,
          )) ||
        // A date field takes only a real calendar day, as YYYY-MM-DD.
        (is(node, "HTMLInputElement") &&
          node.type === "date" &&
          !isValidIsoDate(command.text)) ||
        (policy.protectedValueKind === "verification-code"
          ? codeBoxes === null
          : sensitivity(node) !== null))
    )
      return denied();
  }
  if (
    command.subaction === "fill" &&
    is(node, "HTMLInputElement") &&
    node.type === "file"
  )
    return {
      error: {
        kind: "POLICY_BLOCKED",
        reason: "file-upload-requires-host-picker",
        message:
          "File uploads must be chosen by the person through the host file picker.",
        accept: node.getAttribute("accept") || null,
        multiple: node.multiple === true,
      },
    };
  const findDeep = (root, selector) => {
    const out = [];
    const seen = new Set();
    const visit = (scope) => {
      if (!scope || typeof scope.querySelectorAll !== "function") return;
      for (const item of scope.querySelectorAll(selector)) {
        if (!seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
      for (const el of scope.querySelectorAll("*"))
        if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    if (root?.shadowRoot) visit(root.shadowRoot);
    return out;
  };
  const matchUniqueOption = (items, wanted, getLabel, getValue, isDisabled) => {
    const target = String(wanted ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const exact = items.filter((item) => getLabel(item) === target);
    const matches =
      exact.length > 0
        ? exact
        : (() => {
            const lower = target.toLowerCase();
            const ci = items.filter(
              (item) => getLabel(item).toLowerCase() === lower,
            );
            if (ci.length > 0) return ci;
            return items.filter((item) => {
              const val = getValue(item);
              return (
                typeof val === "string" &&
                val.trim().toLowerCase() === lower
              );
            });
          })();
    if (matches.length !== 1 || isDisabled(matches[0])) return null;
    return matches[0];
  };
  const findAriaOptionElements = (host) => {
    const role = (host.getAttribute("role") || "").toLowerCase();
    const scope = host.getRootNode();
    const out = [];
    const pushAll = (container, sel) => {
      if (!container) return;
      for (const el of findDeep(container, sel))
        if (!out.includes(el)) out.push(el);
    };
    if (role === "radiogroup") {
      pushAll(host, "[role=radio],input[type=radio]");
      return out;
    }
    for (const attr of ["aria-controls", "aria-owns"]) {
      const ids = (host.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const controlled =
          scope.getElementById?.(id) ?? document.getElementById(id);
        if (controlled) pushAll(controlled, "[role=option]");
      }
    }
    pushAll(host, "[role=option]");
    if (out.length === 0) {
      for (const lb of findDeep(scope, "[role=listbox]")) {
        if (lb.checkVisibility?.({ checkVisibilityCSS: true }))
          pushAll(lb, "[role=option]");
      }
      if (out.length === 0 && scope !== document) {
        for (const lb of findDeep(document, "[role=listbox]")) {
          if (lb.checkVisibility?.({ checkVisibilityCSS: true }))
            pushAll(lb, "[role=option]");
        }
      }
    }
    return out;
  };
  const nodeRole = (node.getAttribute("role") || "").toLowerCase();
  const isDateWidget =
    (is(node, "HTMLInputElement") && node.type === "date") ||
    (is(node, "HTMLInputElement") &&
      ["text", "search"].includes(node.type) &&
      (node.hasAttribute("data-provide") ||
        /\b(?:date|calendar|dd\/mm\/yyyy|mm\/dd\/yyyy|yyyy-mm-dd)\b/i.test(
          `${wordsOf(node)} ${node.className || ""}`,
        ))) ||
    (node.shadowRoot &&
      findDeep(node.shadowRoot, "input[type=date],[data-date]").length > 0);
  let selectPlan = null;
  if (command.subaction === "select") {
    if (sensitivity(node) !== null) return denied();
    if (is(node, "HTMLSelectElement")) {
      const chosen =
        !node.multiple
          ? matchUniqueOption(
              [...node.options],
              command.text,
              (opt) => opt.label.replace(/\s+/g, " ").trim(),
              (opt) => opt.value,
              (opt) => opt.disabled || opt.parentElement?.disabled === true,
            )
          : null;
      if (!chosen) return denied();
      selectPlan = { kind: "native-select", option: chosen, target: node };
    } else if (
      ["combobox", "listbox", "radiogroup"].includes(nodeRole) ||
      (node.shadowRoot &&
        findDeep(
          node.shadowRoot,
          "select,[role=combobox],[role=listbox],[role=radiogroup]",
        ).length > 0)
    ) {
      const innerSelect = node.shadowRoot
        ? findDeep(node.shadowRoot, "select")[0]
        : null;
      if (innerSelect && is(innerSelect, "HTMLSelectElement")) {
        const chosen = !innerSelect.multiple
          ? matchUniqueOption(
              [...innerSelect.options],
              command.text,
              (opt) => opt.label.replace(/\s+/g, " ").trim(),
              (opt) => opt.value,
              (opt) => opt.disabled || opt.parentElement?.disabled === true,
            )
          : null;
        if (!chosen) return denied();
        selectPlan = {
          kind: "native-select",
          option: chosen,
          target: innerSelect,
        };
      } else {
        const widget = ["combobox", "listbox", "radiogroup"].includes(nodeRole)
          ? node
          : findDeep(
              node.shadowRoot,
              "[role=combobox],[role=listbox],[role=radiogroup]",
            )[0];
        const widgetRole = (widget?.getAttribute("role") || "").toLowerCase();
        const existing = widget ? findAriaOptionElements(widget) : [];
        const matched =
          existing.length > 0
            ? matchUniqueOption(
                existing,
                command.text,
                (opt) =>
                  (accessibleName(opt) || opt.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim(),
                (opt) =>
                  opt.getAttribute("data-value") ??
                  (typeof opt.value === "string" ? opt.value : null),
                (opt) =>
                  opt.disabled === true ||
                  opt.getAttribute("aria-disabled") === "true",
              )
            : null;
        if (matched) {
          selectPlan = { kind: "aria-option", widget, option: matched };
        } else if (
          widget &&
          widgetRole === "combobox" &&
          existing.length === 0
        ) {
          selectPlan = { kind: "aria-combobox-open", widget };
        } else {
          return denied();
        }
      }
    } else if (
      nodeRole === "option" ||
      nodeRole === "radio" ||
      (is(node, "HTMLInputElement") && node.type === "radio")
    ) {
      const optLabel = (accessibleName(node) || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const optValue =
        node.getAttribute("data-value") ??
        (typeof node.value === "string" ? node.value : "");
      const wanted = command.text.replace(/\s+/g, " ").trim();
      if (
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        (wanted !== "" &&
          optLabel.toLowerCase() !== wanted.toLowerCase() &&
          optValue.toLowerCase() !== wanted.toLowerCase())
      )
        return denied();
      selectPlan = { kind: "aria-option", widget: node, option: node };
    } else if (isDateWidget) {
      const preferMdy = (node.getAttribute("placeholder") || "")
        .toLowerCase()
        .includes("mm/dd/yyyy");
      const parsedDate = parseDateText(command.text, preferMdy);
      if (!parsedDate) return denied();
      selectPlan = { kind: "date-widget", target: node, parsedDate };
    } else {
      return denied();
    }
  }
  if (
    ["fill", "select"].includes(command.subaction) &&
    (node.disabled ||
      node.readOnly ||
      node.getAttribute("aria-disabled") === "true" ||
      node.getAttribute("aria-readonly") === "true")
  )
    return denied();
  // A control the provider disabled stays as the provider left it. A script
  // click on an aria-disabled control would still run the page's handlers.
  if (
    policy &&
    command.subaction === "click" &&
    node.matches(':disabled,[aria-disabled="true"]')
  )
    return denied();
  // Follow the observed address without activating website click handlers.
  // This is distinct from a click or a consented form submission. The snapshot
  // retains the exact destination privately; model-supplied URLs are not used.
  let destination = null;
  if (command.subaction === "follow") {
    if (
      !policy ||
      frameOf(node) !== null ||
      !is(node, "HTMLAnchorElement") ||
      !node.hasAttribute("href") ||
      node.hasAttribute("download") ||
      (node.target &&
        node.target !== "_self" &&
        policy.allowNewTabFollow !== true) ||
      node.matches('[aria-disabled="true"]') ||
      node.href !== recorded.href
    )
      return denied();
    try {
      destination = new URL(recorded.href);
      const policyUrl = new URL(policy.origin);
      const protocolOk =
        destination.protocol === "https:" ||
        (destination.protocol === "http:" &&
          policyUrl.protocol === "http:" &&
          isLoopbackHost(destination.hostname));
      const allowedList = Array.isArray(policy.allowedOrigins)
        ? policy.allowedOrigins.filter((entry) => typeof entry === "string")
        : [];
      const originOk =
        destination.origin === policy.origin ||
        allowedList.includes(destination.origin) ||
        (policy.allowSameSiteSubdomains === true &&
          destination.protocol === policyUrl.protocol &&
          sameRegistrableSite(destination.hostname, policyUrl.hostname));
      if (
        !protocolOk ||
        !originOk ||
        destination.username ||
        destination.password
      )
        return denied();
    } catch {
      return denied();
    }
  }
  if (validateOnly) return { validated: true };
  if (policy?.actionId) {
    const feedback = store.__elizaPageGuidanceV1;
    if (
      !feedback?.actionReady?.(
        policy.actionId,
        command.snapshotId,
        command.nodeId,
        command.subaction,
      )
    )
      return denied();
    feedback.markActed();
  }
  delete store[key];
  if (destination) {
    store[watchKey]?.stop();
    location.assign(destination.href);
    return { dispatched: true, requiresReadback: true };
  }
  if (grant) {
    if (store[grantKey]?.document !== document)
      store[grantKey] = { document, used: new Set() };
    store[grantKey].used.add(grant.grantId);
  }
  let previousWatchHandoff;
  if (
    policy &&
    ["click", "fill", "select", "scroll"].includes(command.subaction)
  ) {
    // A task fill or click must not submit a form or leave the page, also
    // not through the page's own script (an auto-submitting code field, or
    // a button that calls form.submit()). Until the task binding expires, or
    // until the next task fill or click, watch what the page does before the
    // person takes over by activating a control:
    // - a form submit or a page change to another document is stopped,
    //   except a click on a link that opens that link;
    // - a same-document address change (history.pushState) is recorded;
    // - a fetch, XMLHttpRequest or beacon to the page's own site is recorded.
    //   It cannot be stopped from here and may already have committed
    //   something (a code field that verifies itself with fetch).
    // Snapshots report the first of these, so the host treats the outcome as
    // unknown and pauses the task. A request still in flight when a snapshot
    // is read shows up in a later snapshot.
    //
    // This page realm sees only its own document's resource timing. The
    // browser host also watches the network for every frame, at request start
    // (see effect-watch.mjs); snapshots hand it the person's presses and the
    // consented commit as watchHandoff, so it can tell her requests apart.
    //
    // With a commit grant, the one commit the person said yes to goes ahead,
    // once: either the submit the granted control itself sends (and the page
    // load it sends) to the page's origin, or, when no such page load is under
    // way, the one own-site request the grant names (a script form or a button
    // that sends with fetch). That request is the grant's requestTarget or,
    // without one, the granted submit button's form action; a control that is
    // no submit button and names no requestTarget has none. Its URL must be
    // equal; its method only where the page can see it (a beacon is a POST;
    // fetch and XHR methods are not observable here). A grant with a formHash
    // consents a submit only when the form data actually sent hashes the
    // same, and a request only after such a submit. Snapshots report it as a
    // consented commit, with the hash of the form data sent. A submit from
    // another submitter of the same form, a request that differs from the
    // granted control's (action, method, target or encoding), changed or
    // added form data, a script form.submit() (also one into another window,
    // which is reported), a second submit, another form, another origin, any
    // other own-site request and every other page change, same-document
    // address changes included, are still stopped or recorded as above.
    const views = [
      window,
      ...scan.frames
        .filter((frame) => frame.document?.defaultView)
        .map((frame) => frame.document.defaultView),
    ];
    const prior = store[watchKey];
    prior?.stop();
    // What the earlier watch saw of her up to now. Her press since the last
    // snapshot reaches the network watch's earlier effect only this way.
    if (prior?.scope !== undefined)
      previousWatchHandoff = { scope: prior.scope, ...handoffOf(prior) };
    const anchor =
      command.subaction === "click" ? node.closest("a[href]") : null;
    let personAt = Number.NEGATIVE_INFINITY;
    let activationAt = Number.POSITIVE_INFINITY;
    const startedAt = performance.now();
    const controller = new AbortController();
    const watch = {
      violation:
        store[watchKey]?.violation?.scope === policy.guidanceScope
          ? (store[watchKey]?.violation ?? null)
          : null,
      // A receipt belongs to this dispatch, not an earlier approved action.
      consented: null,
      scope: policy.guidanceScope,
      // For the network watch, in epoch milliseconds: each trusted press,
      // her first activated control, and the URLs of consented commits.
      presses: [],
      activatedAt: null,
      consentedUrls: [],
      expected: null,
      stop: () => controller.abort(),
    };
    // The network watch compares these with request times on the wall clock.
    // performance.now() is monotonic and stops while the device sleeps, so
    // timeOrigin + performance.now() falls behind Date.now() by every sleep
    // since the page loaded; the handoff is stamped with Date.now() instead.
    // The granted control's own form: the only form the grant can send.
    const grantedForm = grant
      ? (node.form ?? node.closest("form") ?? null)
      : null;
    const overrides = ["formaction", "formmethod", "formtarget", "formenctype"];
    const sameRequest = (a, b) =>
      a.action === b.action &&
      a.method === b.method &&
      a.target === b.target &&
      a.enctype === b.enctype;
    // Read before the click, so a script that runs after it cannot move the
    // granted request. Only a submit button of the granted form has one.
    const grantedRequest =
      grantedForm !== null && submitControl(node) && node.form === grantedForm
        ? requestOf(node, grantedForm)
        : null;
    // A submit with no submitter (requestSubmit() with no argument, or an
    // implicit submission) sends what the granted control would only when that
    // control is the form's default button and overrides nothing.
    const implicitAllowed =
      grantedRequest !== null &&
      defaultButton(grantedForm) === node &&
      !overrides.some((attribute) => node.hasAttribute(attribute));
    // The one request the grant consents besides its form's page load. A
    // declared target is matched exactly; a GET form's action by origin and
    // path, since the submit replaces its query.
    const declared = grant?.requestTarget ?? null;
    const expectedRequest = (() => {
      try {
        if (declared)
          return {
            url: new URL(declared.url ?? declared.path, location.origin).href,
            method: declared.method,
            exact: true,
          };
        if (grantedRequest === null || grantedRequest.method === "dialog")
          return null;
        return {
          url: new URL(grantedRequest.action, location.href).href,
          method: grantedRequest.method.toUpperCase(),
          exact: grantedRequest.method !== "get",
        };
      } catch {
        return null;
      }
    })();
    watch.expected = expectedRequest;
    const sameUrl = (url, expected) => {
      try {
        const a = new URL(url, location.href);
        const b = new URL(expected.url);
        a.hash = "";
        b.hash = "";
        return expected.exact
          ? a.href === b.href
          : a.origin === b.origin && a.pathname === b.pathname;
      } catch {
        return false;
      }
    };
    // Keep identical to commitFormHash in plugin-browser's
    // commit-form-hash.ts: hosts compute a grant's formHash with it.
    const commitFormHash = (entries) => {
      const pairs = [];
      const normal = (text) => text.replace(/\r\n?/g, "\n").normalize("NFC");
      for (const [name, value] of entries)
        if (typeof value === "string")
          pairs.push([normal(name), normal(value)]);
      const bytes = new TextEncoder().encode(
        `eliza-commit-form-v1\n${JSON.stringify(pairs)}`,
      );
      const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
      ];
      const hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
        0x1f83d9ab, 0x5be0cd19,
      ];
      const padded = new Uint8Array(((bytes.length + 72) >> 6) << 6);
      padded.set(bytes);
      padded[bytes.length] = 0x80;
      const view = new DataView(padded.buffer);
      view.setUint32(
        padded.length - 8,
        Math.floor((bytes.length * 8) / 2 ** 32),
      );
      view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
      const w = new Uint32Array(64);
      const rotate = (x, n) => (x >>> n) | (x << (32 - n));
      for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++)
          w[i] =
            w[i - 16] +
            (rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)) +
            w[i - 7] +
            (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10));
        let [a, b, c, d, e, f, g, h] = hash;
        for (let i = 0; i < 64; i++) {
          const t1 =
            (h +
              (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
              ((e & f) ^ (~e & g)) +
              k[i] +
              w[i]) |
            0;
          const t2 =
            ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
              ((a & b) ^ (a & c) ^ (b & c))) |
            0;
          h = g;
          g = f;
          f = e;
          e = (d + t1) | 0;
          d = c;
          c = b;
          b = a;
          a = (t1 + t2) | 0;
        }
        [a, b, c, d, e, f, g, h].forEach((value, i) => {
          hash[i] = (hash[i] + value) | 0;
        });
      }
      return hash
        .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
        .join("");
    };
    // Our own FormData read fires the form's formdata event; it is no submit.
    let reading = false;
    const formDataHash = (form, submitter) => {
      reading = true;
      try {
        let data;
        try {
          data = new FormData(form, submitter);
        } catch {
          data = new FormData(form);
          if (submitter?.name) data.append(submitter.name, submitter.value);
        }
        return commitFormHash(data);
      } catch {
        return null;
      } finally {
        reading = false;
      }
    };
    // The hash of the form data sent is reported unless the granted form has a
    // password, code or card field and the host did not name the hash itself.
    const reportHash =
      grant?.formHash !== undefined ||
      (grantedForm !== null &&
        ![...grantedForm.elements].some((element) => sensitivity(element)));
    // submits: 0 until the granted control's submit event; its page load may
    // then follow once (pending, to action by method). spent: the one commit
    // went through.
    const consent = grant
      ? {
          grantId: grant.grantId,
          submits: 0,
          pending: false,
          action: "",
          method: "",
          implicit: false,
          spent: false,
          formHash: null,
          formMatched: false,
        }
      : null;
    const consentTo = (kind, url) => {
      watch.consentedUrls.push(url);
      watch.consented ??= {
        grantId: consent.grantId,
        kind,
        scope: policy.guidanceScope,
      };
      if (reportHash && consent.formHash) {
        watch.consented.formHash = consent.formHash;
      }
    };
    const sameOrigin = (url) => {
      try {
        return new URL(url, location.href).origin === location.origin;
      } catch {
        return false;
      }
    };
    // A GET submit replaces the query, so only origin and path identify it.
    const samePath = (url, other) => {
      try {
        const a = new URL(url, location.href);
        const b = new URL(other, location.href);
        return a.origin === b.origin && a.pathname === b.pathname;
      } catch {
        return false;
      }
    };
    // A person's activated control can finish after the short typing window.
    // Stray taps, scrolling and ordinary typing do not create that handoff.
    // Resource start times still expose older requests delivered afterward.
    const byPerson = (at) =>
      at >= activationAt || (at - personAt >= 0 && at - personAt <= 1500);
    const record = (kind) => {
      watch.violation ??= { kind, scope: policy.guidanceScope };
    };
    const report = (kind, event) => {
      if (byPerson(performance.now())) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      record(kind);
    };
    const options = { capture: true, signal: controller.signal };
    const watched = {
      addEventListener: (...listener) => {
        for (const view of views) view.addEventListener(...listener);
      },
    };
    const navigations = {
      addEventListener: (...listener) => {
        for (const view of views)
          view.navigation?.addEventListener(...listener);
      },
    };
    const person = (event) => {
      if (!event.isTrusted) return;
      personAt = performance.now();
      watch.presses.push(Date.now());
    };
    const personForms = new WeakSet();
    watched.addEventListener("pointerdown", person, options);
    watched.addEventListener("keydown", person, options);
    const activate = (event) => {
      if (!event.isTrusted || !is(event.target, "Element")) return;
      const target = event.target;
      const control = target.closest(
        'button,input[type="submit"],input[type="button"],input[type="reset"],a[href],[role="button"],[role="link"]',
      );
      if (control?.matches(':disabled,[aria-disabled="true"]')) return;
      const keyboard = event.type === "keydown";
      const fields =
        "textarea,select,input:not([type=submit]):not([type=button]):not([type=reset])";
      const field = target.isContentEditable || target.matches(fields);
      // A custom control (no button element or button role) can send its form
      // from script seconds later. Her press on such a control makes that form
      // hers for the rest of this watch. Only an element that presents itself
      // as a control counts: a widget role, a tabindex, an inline click
      // handler, or a pointer cursor on the pressed element. A press on the
      // form's own padding, on plain text, on a field, on a label, or on an
      // element that wraps a field is a stray tap and releases nothing.
      const form = target.closest("form");
      if (
        !keyboard &&
        form &&
        target !== form &&
        !field &&
        !target.closest("label")
      ) {
        for (
          let item = target;
          item && item !== form;
          item = item.parentElement
        ) {
          if (item.querySelector(fields) || item.querySelector("label")) break;
          if (
            item === control ||
            item.matches(
              '[tabindex],[onclick],[role="menuitem"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"]',
            ) ||
            (item === target && styleOf(item).cursor === "pointer")
          ) {
            if (!item.matches('[aria-disabled="true"]')) personForms.add(form);
            break;
          }
        }
      }
      const enterForm =
        event.key === "Enter" && is(target, "HTMLInputElement") && target.form;
      const controlKey =
        control &&
        !field &&
        (event.key === "Enter" ||
          (event.key === " " && !control.matches('a[href],[role="link"]')));
      if (keyboard ? !controlKey && !enterForm : !control) return;
      activationAt = Math.min(activationAt, performance.now());
      watch.activatedAt ??= Date.now();
    };
    watched.addEventListener("click", activate, options);
    watched.addEventListener("keydown", activate, options);
    // The last submit event, so the form data it sends is not taken for a
    // script form.submit(), which sends no submit event.
    let lastSubmit = null;
    let allowedWizardSubmit = null;
    watched.addEventListener(
      "submit",
      (event) => {
        lastSubmit = event;
        if (personForms.has(event.target)) return;
        const form = event.target;
        const submitter = event.submitter ?? null;
        const sent = is(form, "HTMLFormElement")
          ? requestOf(submitter, form)
          : null;
        // The form data this submit sends, as the person saw it or not.
        const sentHash =
          consent && form === grantedForm
            ? formDataHash(form, submitter)
            : null;
        if (
          consent &&
          !consent.spent &&
          consent.submits === 0 &&
          grantedRequest !== null &&
          form === grantedForm &&
          (submitter === node || (submitter === null && implicitAllowed)) &&
          sameRequest(sent, grantedRequest) &&
          sent.method !== "dialog" &&
          sameOrigin(sent.action) &&
          ["", "_self"].includes(sent.target) &&
          (grant.formHash === undefined || sentHash === grant.formHash)
        ) {
          consent.submits = 1;
          consent.pending = true;
          consent.action = sent.action;
          consent.method = sent.method;
          consent.implicit = submitter === null;
          consent.formHash = sentHash;
          consent.formMatched = grant.formHash !== undefined;
          consentTo("submit", sent.action);
          // A page handler that cancels this submit sends no page load, so
          // none may follow it later; one own-site request still may.
          setTimeout(() => {
            if (event.defaultPrevented) consent.pending = false;
          }, 0);
          return;
        }
        // A permitted non-commit wizard/search GET or POST submitter on the same
        // origin may advance without tripping an unauthorized-commit violation.
        if (
          command.subaction === "click" &&
          !grant &&
          clickedConsequence !== "commit" &&
          sent &&
          (sent.method === "get" || sent.method === "post") &&
          sameOrigin(sent.action) &&
          ["", "_self"].includes(sent.target) &&
          form === node.form &&
          (submitter === node || submitter === null)
        ) {
          allowedWizardSubmit = {
            form,
            action: sent.action,
            method: sent.method,
          };
          return;
        }
        report("submit", event);
      },
      options,
    );
    // A script form.submit() sends no submit event. Into this window its page
    // load is stopped below; into another window or frame (target=_blank) it
    // is not seen there, so its form data being read is reported here.
    watched.addEventListener(
      "formdata",
      (event) => {
        if (reading) return;
        const form = event.target;
        const submitted =
          lastSubmit?.target === form && !lastSubmit.defaultPrevented;
        lastSubmit = null;
        if (
          submitted ||
          !is(form, "HTMLFormElement") ||
          personForms.has(form) ||
          byPerson(performance.now()) ||
          ["", "_self", "_top", "_parent"].includes(
            form.target.trim().toLowerCase(),
          )
        )
          return;
        record("submit");
      },
      options,
    );
    navigations.addEventListener(
      "navigate",
      (event) => {
        // Chromium marks the page load of a script click on a submit button
        // as user initiated; for a form submission only her own press counts.
        const formLoad =
          event.formData != null ||
          is(event.sourceElement, "HTMLFormElement") ||
          event.sourceElement?.form !== undefined;
        if (
          (event.userInitiated && (!formLoad || byPerson(performance.now()))) ||
          (anchor &&
            !event.formData &&
            event.destination.url === anchor.href) ||
          personForms.has(event.sourceElement?.form ?? event.sourceElement)
        )
          return;
        if (event.destination.sameDocument) {
          // Recorded, not stopped: the page's own state has already moved.
          // Permitted SPA clicks (including granted commits) may transition hash/history routes.
          if (
            command.subaction === "click" &&
            (grant || clickedConsequence !== "commit") &&
            policy.allowSameDocumentNavigation !== false
          )
            return;
          if (!byPerson(performance.now())) record("navigation");
          return;
        }
        if (
          allowedWizardSubmit &&
          sameOrigin(event.destination.url) &&
          samePath(event.destination.url, allowedWizardSubmit.action) &&
          (allowedWizardSubmit.method === "post"
            ? event.formData != null
            : event.formData == null) &&
          (event.sourceElement === node ||
            event.sourceElement === allowedWizardSubmit.form ||
            !("sourceElement" in event))
        ) {
          allowedWizardSubmit = null;
          return;
        }
        // Commit-granted non-form button navigating within the same origin (e.g. location.href).
        if (
          consent &&
          !consent.spent &&
          !consent.pending &&
          grantedForm === null &&
          command.subaction === "click" &&
          event.formData == null &&
          sameOrigin(event.destination.url) &&
          (!declared ||
            samePath(event.destination.url, expectedRequest?.url ?? ""))
        ) {
          consent.spent = true;
          consentTo("navigation", event.destination.url);
          return;
        }
        // Permitted non-commit main-frame button click navigating within the same origin.
        if (
          command.subaction === "click" &&
          !grant &&
          clickedConsequence !== "commit" &&
          frameOf(node) === null &&
          event.formData == null &&
          sameOrigin(event.destination.url) &&
          policy.allowSameOriginNavigation !== false
        ) {
          return;
        }
        // A form submission's source is its submitter, or the form itself
        // when it has none (also a script form.submit()).
        const source = event.sourceElement;
        const fromGranted =
          source === node ||
          (consent?.implicit === true &&
            grantedForm !== null &&
            source === grantedForm);
        if (
          consent &&
          !consent.spent &&
          sameOrigin(event.destination.url) &&
          // Only the page load of the granted submit (POST or GET). A script
          // form.submit() sends no submit event and is never consented.
          consent.pending &&
          samePath(event.destination.url, consent.action) &&
          (consent.method === "post"
            ? event.formData != null
            : event.formData == null) &&
          (fromGranted || !("sourceElement" in event)) &&
          // A declared request target binds the page load too.
          (!declared ||
            (samePath(event.destination.url, expectedRequest?.url ?? "") &&
              declared.method === consent.method.toUpperCase()))
        ) {
          // The form data this page load actually sends: what page handlers
          // left in it after the submit event, or a GET submit's query.
          let loaded = null;
          try {
            loaded = commitFormHash(
              event.formData ?? new URL(event.destination.url).searchParams,
            );
          } catch {}
          if (grant.formHash === undefined || loaded === grant.formHash) {
            consent.submits = 1;
            consent.pending = false;
            consent.spent = true;
            consent.formHash = loaded;
            consentTo("submit", event.destination.url);
            if (reportHash && loaded) watch.consented.formHash = loaded;
            return;
          }
        }
        // The granted submit's own page load is not the one she said yes to
        // (its form data changed after the submit event): no receipt.
        if (
          consent?.pending &&
          !consent.spent &&
          (fromGranted || (grantedForm !== null && source === grantedForm))
        ) {
          consent.pending = false;
          consent.spent = true;
          watch.consented = null;
        }
        report(event.formData ? "submit" : "navigation", event);
      },
      { signal: controller.signal },
    );
    // The page's own site, without public-suffix data: a request host counts
    // when its last two or its last three labels match the page's. This errs
    // toward recording (a.co.uk and b.co.uk match), never toward missing a
    // sibling host such as api.dkb.de for banking.dkb.de.
    const tail = (host, count) => host.split(".").slice(-count).join(".");
    const sameSite = (host) =>
      host === location.hostname ||
      tail(host, 2) === tail(location.hostname, 2) ||
      tail(host, 3) === tail(location.hostname, 3);
    for (const view of views) {
      if (typeof view.PerformanceObserver !== "function") continue;
      const shift = view.performance.timeOrigin - performance.timeOrigin;
      const requests = new view.PerformanceObserver((list) => {
        // Oldest first, so the granted action's own request is the one used.
        const entries = [...list.getEntries()]
          .map(({ name, initiatorType, startTime }) => ({
            name,
            initiatorType,
            startTime: startTime + shift,
          }))
          .sort((a, b) => a.startTime - b.startTime);
        for (const entry of entries) {
          // Resource timing carries no method, so a read and a write look the
          // same here: past 30 s (CROSS_SITE_WINDOW_MS in effect-watch.mjs) a
          // site's own poll is not taken for the effect's. The network watch,
          // which sees the method, judges writes for the rest of the binding.
          if (
            entry.startTime < startedAt ||
            entry.startTime - startedAt > 30000 ||
            !["fetch", "xmlhttprequest", "beacon"].includes(
              entry.initiatorType,
            ) ||
            byPerson(entry.startTime)
          )
            continue;
          let host = "";
          try {
            host = new URL(entry.name).hostname;
          } catch {
            continue;
          }
          if (sameSite(host)) {
            // The granted request may carry the commit when no granted page
            // load is under way or done; every other is recorded. Under a
            // formHash it follows a submit whose form data matched.
            if (
              consent &&
              !consent.spent &&
              !consent.pending &&
              expectedRequest !== null &&
              sameUrl(entry.name, expectedRequest) &&
              (entry.initiatorType !== "beacon" ||
                expectedRequest.method === "POST") &&
              (grant.formHash === undefined || consent.formMatched)
            ) {
              consent.spent = true;
              consentTo("request", entry.name);
              continue;
            }
            // Commit-granted JS/SPA button click (no form action or declared requestTarget)
            // may invoke same-origin fetch/XHR to execute and refresh UI state.
            if (
              consent &&
              !consent.pending &&
              expectedRequest === null &&
              grant.formHash === undefined &&
              command.subaction === "click" &&
              sameOrigin(entry.name) &&
              entry.initiatorType !== "beacon" &&
              policy.allowSameOriginRequests !== false
            ) {
              if (!consent.spent) {
                consent.spent = true;
                consentTo("request", entry.name);
              }
              continue;
            }
            // Permitted non-commit click or select may trigger same-origin SPA fetch/XHR
            // (e.g. tab loading, cart updates, dependent dropdowns); fill/code-fill stays watched.
            if (
              !grant &&
              ["click", "select"].includes(command.subaction) &&
              clickedConsequence !== "commit" &&
              sameOrigin(entry.name) &&
              entry.initiatorType !== "beacon" &&
              policy.allowSameOriginRequests !== false
            ) {
              continue;
            }
            record("request");
            break;
          }
        }
      });
      requests.observe({ type: "resource" });
      controller.signal.addEventListener("abort", () => requests.disconnect());
    }
    // A timer delay above 2^31 - 1 ms fires at once; the cap is 24.8 days.
    setTimeout(
      () => controller.abort(),
      Math.min(policy.expiresAt - Date.now(), 2 ** 31 - 1),
    );
    store[watchKey] = watch;
  }
  const commitCustomDateWidget = (target, parsedDate, rawText = null) => {
    const targetView = realmOf(target);
    const dispatchKey = (el, type, key, keyCode) => {
      try {
        el.dispatchEvent(
          new targetView.KeyboardEvent(type, {
            key,
            code: key,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      } catch {
        el.dispatchEvent(
          new targetView.Event(type, { bubbles: true, composed: true }),
        );
      }
    };
    const setVal = (el, val) => {
      Object.getOwnPropertyDescriptor(
        targetView.HTMLInputElement.prototype,
        "value",
      ).set.call(el, val);
      el.dispatchEvent(
        new targetView.Event("input", { bubbles: true, composed: true }),
      );
      el.dispatchEvent(
        new targetView.Event("change", { bubbles: true, composed: true }),
      );
    };
    const ph = (target.getAttribute?.("placeholder") || "").toLowerCase();
    const formattedDate = ph.includes("dd/mm/yyyy")
      ? `${String(parsedDate.day).padStart(2, "0")}/${String(parsedDate.month).padStart(2, "0")}/${parsedDate.year}`
      : ph.includes("mm/dd/yyyy")
        ? `${String(parsedDate.month).padStart(2, "0")}/${String(parsedDate.day).padStart(2, "0")}/${parsedDate.year}`
        : rawText && String(rawText).trim()
          ? String(rawText).trim()
          : parsedDate.iso;
    try {
      target.focus?.();
    } catch {}
    try {
      target.dispatchEvent(
        new targetView.FocusEvent("focus", { bubbles: false }),
      );
      target.dispatchEvent(
        new targetView.FocusEvent("focusin", { bubbles: true, composed: true }),
      );
    } catch {}
    target.click?.();
    if (is(target, "HTMLInputElement")) {
      setVal(target, formattedDate);
      // Bootstrap Datepicker / jQuery UI sync the visible calendar month/year & .active cell on keyup.
      dispatchKey(target, "keyup", "0", 48);
    }
    const searchRoots = [
      target,
      ...(target.shadowRoot ? [target.shadowRoot] : []),
      target.getRootNode(),
      document,
    ];
    const isVisibleEl = (el) =>
      el.checkVisibility?.({ checkVisibilityCSS: true }) !== false &&
      el.getBoundingClientRect?.().width > 0 &&
      el.getBoundingClientRect?.().height > 0;
    const findDateCell = () => {
      for (const root of searchRoots) {
        const exact = findDeep(root, `[data-date="${parsedDate.iso}"]`).find(
          (el) =>
            isVisibleEl(el) &&
            !el.matches(":disabled,[aria-disabled=true],.disabled"),
        );
        if (exact) return exact;
      }
      for (const selector of [
        ".datepicker-days td.day.active:not(.disabled),.flatpickr-day.selected:not(.disabled),.ui-datepicker-calendar a.ui-state-active",
        ".datepicker-days td.day:not(.disabled):not(.old):not(.new),.flatpickr-day:not(.disabled),.ui-datepicker-calendar td:not(.ui-datepicker-unselectable) a",
        "[role=gridcell]:not([aria-disabled=true])",
      ]) {
        for (const root of searchRoots) {
          const cells = findDeep(root, selector).filter(
            (el) =>
              isVisibleEl(el) &&
              (el.textContent || "").trim() === String(parsedDate.day),
          );
          if (cells.length === 1) return cells[0];
        }
      }
      return null;
    };
    const cell = findDateCell();
    if (cell) {
      cell.click();
    } else if (is(target, "HTMLInputElement")) {
      dispatchKey(target, "keydown", "Enter", 13);
      dispatchKey(target, "keyup", "Enter", 13);
    }
    try {
      target.blur?.();
    } catch {}
    try {
      target.dispatchEvent(
        new targetView.FocusEvent("blur", { bubbles: false }),
      );
      target.dispatchEvent(
        new targetView.FocusEvent("focusout", { bubbles: true, composed: true }),
      );
    } catch {}
    if (is(target, "HTMLInputElement") && target.value === "") {
      setVal(target, formattedDate);
      dispatchKey(target, "keydown", "Enter", 13);
      dispatchKey(target, "keyup", "Enter", 13);
    }
    // Dismiss any still-open JS datepicker popup without losing the committed date value.
    const openPopup = findDeep(
      document,
      ".datepicker-dropdown,.datepicker,.flatpickr-calendar.open,#ui-datepicker-div,.react-datepicker",
    ).find(isVisibleEl);
    if (openPopup && (!is(target, "HTMLInputElement") || target.value !== "")) {
      const committed = is(target, "HTMLInputElement") ? target.value : null;
      dispatchKey(target, "keydown", "Escape", 27);
      dispatchKey(target, "keyup", "Escape", 27);
      if (isVisibleEl(openPopup)) {
        try {
          document.body?.dispatchEvent(
            new targetView.MouseEvent("mousedown", { bubbles: true }),
          );
          document.body?.dispatchEvent(
            new targetView.MouseEvent("mouseup", { bubbles: true }),
          );
        } catch {}
      }
      if (
        committed &&
        is(target, "HTMLInputElement") &&
        target.value === ""
      ) {
        setVal(target, committed);
      }
    }
    return is(target, "HTMLInputElement") ? target.value !== "" : !!cell;
  };
  if (command.subaction === "click") {
    // Only text changed during this exact synchronous activation is eligible.
    // Timers and later requests are not attributed to this click. Retain the
    // visible text privately until one snapshot confirms it is still present;
    // neither text nor input values are included in the receipt. This proves
    // a UI response, never a completed goal or a committed payment.
    delete monitor.clickReadback;
    const before =
      policy && typeof policy.guidanceScope === "string"
        ? readVisibleText(document.body ?? document.documentElement)
        : null;
    node.click();
    if (before !== null)
      monitor.clickReadback = {
        targetRef: `${state.snapshotId}:0:${command.nodeId}`,
        scope: policy.guidanceScope,
        before,
        after: readVisibleText(document.body ?? document.documentElement),
      };
  } else if (command.subaction === "fill") {
    const type = [
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
    ].find((name) => is(node, name));
    const editable = node.isContentEditable === true;
    if (
      (!type && !editable) ||
      node.disabled ||
      node.readOnly ||
      node.getAttribute("aria-disabled") === "true" ||
      node.getAttribute("aria-readonly") === "true"
    )
      return {
        error: {
          kind: "UNSUPPORTED",
          message: "The target is not an editable form control.",
        },
      };
    const view = realmOf(node);
    const dispatchFocus = (box) => {
      try {
        box.focus?.();
      } catch {}
      try {
        box.dispatchEvent(new view.FocusEvent("focus", { bubbles: false }));
        box.dispatchEvent(
          new view.FocusEvent("focusin", { bubbles: true, composed: true }),
        );
      } catch {
        box.dispatchEvent(new view.Event("focus", { bubbles: false }));
      }
    };
    const dispatchBlur = (box) => {
      try {
        box.blur?.();
      } catch {}
      try {
        box.dispatchEvent(new view.FocusEvent("blur", { bubbles: false }));
        box.dispatchEvent(
          new view.FocusEvent("focusout", { bubbles: true, composed: true }),
        );
      } catch {
        box.dispatchEvent(new view.Event("blur", { bubbles: false }));
      }
    };
    const write = (box, text, blurAfter = true) => {
      dispatchFocus(box);
      if (box.isContentEditable) {
        try {
          box.dispatchEvent(
            new view.InputEvent("beforeinput", {
              bubbles: true,
              composed: true,
              data: text,
              inputType: "insertReplacementText",
            }),
          );
        } catch {
          box.dispatchEvent(
            new view.Event("beforeinput", { bubbles: true, composed: true }),
          );
        }
        box.textContent = text;
        try {
          box.dispatchEvent(
            new view.InputEvent("input", {
              bubbles: true,
              composed: true,
              data: text,
              inputType: "insertText",
            }),
          );
        } catch {
          box.dispatchEvent(
            new view.Event("input", { bubbles: true, composed: true }),
          );
        }
        box.dispatchEvent(
          new view.Event("change", { bubbles: true, composed: true }),
        );
      } else {
        const boxType =
          [
            "HTMLInputElement",
            "HTMLTextAreaElement",
            "HTMLSelectElement",
          ].find((name) => is(box, name)) ?? type;
        Object.getOwnPropertyDescriptor(
          view[boxType].prototype,
          "value",
        ).set.call(box, text);
        box.dispatchEvent(
          new view.Event("input", { bubbles: true, composed: true }),
        );
        box.dispatchEvent(
          new view.Event("change", { bubbles: true, composed: true }),
        );
      }
      if (blurAfter) dispatchBlur(box);
    };
    const targetRef = `${state.snapshotId}:0:${command.nodeId}`;
    if (codeBoxes) {
      const parts = codeBoxes.length > 1 ? [...command.text] : [command.text];
      for (const [index, box] of codeBoxes.entries()) {
        if (
          index > 0 &&
          !(box.isConnected && codeBox(box) && !box.disabled && !box.readOnly)
        )
          break;
        write(box, parts[index], index === codeBoxes.length - 1);
      }
      const until = Date.now() + 900000;
      monitor.heldCodes = [
        ...(monitor.heldCodes ?? []).filter((code) => code.until > Date.now()),
        { text: command.text, until },
      ].slice(-4);
      monitor.codeReadback = {
        nodes: codeBoxes,
        parts,
        targetRef,
        scope: policy.guidanceScope,
        until,
      };
    } else {
      const preferMdy = (node.getAttribute?.("placeholder") || "")
        .toLowerCase()
        .includes("mm/dd/yyyy");
      const parsedFillDate =
        isDateWidget &&
        is(node, "HTMLInputElement") &&
        node.type !== "date"
          ? parseDateText(command.text, preferMdy)
          : null;
      if (parsedFillDate) {
        commitCustomDateWidget(node, parsedFillDate, command.text);
      } else {
        write(node, command.text, true);
      }
      if (policy && !sensitivity(node))
        monitor.inputReadback = {
          node,
          text: command.text,
          targetRef,
          scope: policy.guidanceScope,
        };
    }
  } else if (command.subaction === "select") {
    const view = realmOf(node);
    const setNativeSelect = (selectEl, optionEl) => {
      try {
        selectEl.focus?.();
      } catch {}
      Object.getOwnPropertyDescriptor(
        view.HTMLSelectElement.prototype,
        "selectedIndex",
      ).set.call(selectEl, optionEl.index);
      selectEl.dispatchEvent(
        new view.Event("input", { bubbles: true, composed: true }),
      );
      selectEl.dispatchEvent(
        new view.Event("change", { bubbles: true, composed: true }),
      );
      try {
        selectEl.blur?.();
      } catch {}
    };
    if (selectPlan?.kind === "native-select") {
      setNativeSelect(selectPlan.target, selectPlan.option);
    } else if (selectPlan?.kind === "aria-option") {
      try {
        selectPlan.option.focus?.();
      } catch {}
      selectPlan.option.click();
    } else if (selectPlan?.kind === "aria-combobox-open") {
      const widget = selectPlan.widget;
      try {
        widget.focus?.();
      } catch {}
      widget.click();
      const opened = findAriaOptionElements(widget);
      const chosen = matchUniqueOption(
        opened,
        command.text,
        (opt) =>
          (accessibleName(opt) || opt.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        (opt) =>
          opt.getAttribute("data-value") ??
          (typeof opt.value === "string" ? opt.value : null),
        (opt) =>
          opt.disabled === true ||
          opt.getAttribute("aria-disabled") === "true",
      );
      if (chosen) {
        try {
          chosen.focus?.();
        } catch {}
        chosen.click();
      } else if (is(widget, "HTMLInputElement") && widget.list) {
        const listOpt = matchUniqueOption(
          [...widget.list.options],
          command.text,
          (opt) =>
            (opt.label || opt.textContent || opt.value || "")
              .replace(/\s+/g, " ")
              .trim(),
          (opt) => opt.value,
          (opt) => opt.disabled === true,
        );
        if (!listOpt) return denied();
        Object.getOwnPropertyDescriptor(
          view.HTMLInputElement.prototype,
          "value",
        ).set.call(widget, listOpt.value);
        widget.dispatchEvent(
          new view.Event("input", { bubbles: true, composed: true }),
        );
        widget.dispatchEvent(
          new view.Event("change", { bubbles: true, composed: true }),
        );
        try {
          widget.blur?.();
        } catch {}
      } else {
        return denied();
      }
    } else if (selectPlan?.kind === "date-widget") {
      const { target, parsedDate } = selectPlan;
      const innerDate =
        is(target, "HTMLInputElement") && target.type === "date"
          ? target
          : target.shadowRoot
            ? findDeep(target.shadowRoot, "input[type=date]")[0] ?? null
            : null;
      if (innerDate) {
        const innerView = realmOf(innerDate);
        try {
          innerDate.focus?.();
        } catch {}
        Object.getOwnPropertyDescriptor(
          innerView.HTMLInputElement.prototype,
          "value",
        ).set.call(innerDate, parsedDate.iso);
        innerDate.dispatchEvent(
          new innerView.Event("input", { bubbles: true, composed: true }),
        );
        innerDate.dispatchEvent(
          new innerView.Event("change", { bubbles: true, composed: true }),
        );
        try {
          innerDate.blur?.();
        } catch {}
      } else {
        if (!commitCustomDateWidget(target, parsedDate, command.text))
          return denied();
      }
    } else {
      return denied();
    }
  } else if (command.subaction === "scroll") {
    node.scrollBy({
      top:
        command.direction === "up"
          ? -500
          : command.direction === "down"
            ? 500
            : 0,
      left:
        command.direction === "left"
          ? -500
          : command.direction === "right"
            ? 500
            : 0,
      behavior: "instant",
    });
  }
  const effectWatch = policy ? store[watchKey] : undefined;
  return {
    dispatched: true,
    completed: false,
    requiresReadback: true,
    // Taken out by the browser host before the result leaves it.
    ...(effectWatch?.scope === policy?.guidanceScope && effectWatch
      ? { watchHandoff: handoffOf(effectWatch) }
      : {}),
    ...(previousWatchHandoff ? { previousWatchHandoff } : {}),
  };
}

/**
 * A snapshot's blockers with their element ids made into the same
 * snapshot-bound selectors as its elements (`<snapshot>:<frame>:<id>`).
 * Shape: `{ kind, ref?, rejectRef?, covers, text? }`, where kind is
 * "modal" | "cookie-consent" | "captcha" | "login-wall" | "paywall" and
 * covers is "viewport" | "target" | "partial".
 */
export function blockerSelectors(blockers, prefix) {
  return (Array.isArray(blockers) ? blockers : []).map(
    ({ ref, rejectRef, ...blocker }) => ({
      ...blocker,
      ...(typeof ref === "string" ? { ref: `${prefix}:${ref}` } : {}),
      ...(typeof rejectRef === "string"
        ? { rejectRef: `${prefix}:${rejectRef}` }
        : {}),
    }),
  );
}

const SAFE_DISMISS_PATTERN =
  /^(?:close|dismiss|no,?\s*thanks|not\s+now|maybe\s+later|skip|decline|reject(?:\s+all)?|keep\s+one[- ]?time(?:\s+purchase)?|×|✕|✖|x)$|^close\b|\b(?:strictly\s+)?(?:necessary|essential|required)\s+(?:cookies\s+)?only\b|\b(?:continue|proceed)\s+without\s+(?:accepting|agreeing|enrolling|upgrading|subscribing|autopay|membership|trial|protection)\b/i;
const DISMISS_AGREES_PATTERN =
  /\b(?:accept|agree|allow|consent|ok(?:ay)?|got it|subscribe|sign|log|buy|pay|confirm|enroll|upgrade)\b/i;
const DECLINE_ESCAPE_PATTERN =
  /\b(?:continue|proceed)\s+without\s+(?:accepting|agreeing|enrolling|upgrading|subscribing|autopay|membership|trial|protection)\b/i;
const SAFE_FORM_STEP_PATTERN =
  /^(?:search|find|go|filter|sort|apply|next|continue|back|previous|review(?:\s+[\w& -]+)?|preview|calculate|estimate|add\s+to\s+(?:cart|bag)|update(?:\s+(?:cart|quantity))?|proceed\s+to\s+(?:checkout|payment|review)|pay\s+(?:card|bill|this\s+bill)|make\s+a\s+payment|continue\s+to\s+[\w -]+|save\s+draft)$/i;
const STAGE_CONTROL_PATTERN =
  /\b(?:add\s+to\s+(?:cart|bag)|one[- ]?time\s+purchase|standard\s+shipping|free\s+shipping|apply|filter|sort|search|select|update\s+(?:cart|quantity)|save\s+draft|statement\s+balance|minimum\s+(?:payment|due)|current\s+balance|other\s+amount)\b/i;

/**
 * Pure, site-agnostic tiered consequence classifier matching the in-page guard
 * inside `pageCommand`. Maps a target descriptor and page context to
 * `"observe" | "navigate" | "stage" | "commit"`.
 */
export function classifyActionConsequence(target = {}, context = {}) {
  const reasons = [];
  const action = target?.action ?? "click";
  if (action === "scroll" || target?.scrollOnly === true)
    return { consequence: "observe", reasons: ["scroll"], requiresGrant: false };
  const tag = String(target?.tag ?? "").toLowerCase();
  const type = String(target?.type ?? "").toLowerCase();
  const role = String(target?.role ?? "").toLowerCase();
  const sensitive = target?.sensitive ?? null;
  if (
    (tag === "input" && type === "password") ||
    ["password", "payment-card", "bank-account", "government-id"].includes(
      sensitive,
    )
  )
    return {
      consequence: "commit",
      reasons: ["sensitive-control"],
      requiresGrant: true,
    };
  if (action === "fill" || action === "select") {
    if (sensitive === "one-time-code")
      return {
        consequence: "commit",
        reasons: ["verification-code"],
        requiresGrant: true,
      };
    if (tag === "input" && type === "file")
      return {
        consequence: "commit",
        reasons: ["file-upload"],
        requiresGrant: true,
      };
    return { consequence: "stage", reasons: [action], requiresGrant: false };
  }
  if (action === "follow")
    return {
      consequence: "navigate",
      reasons: ["follow-link"],
      requiresGrant: false,
    };
  const label = String(target?.label ?? target?.inferredLabel ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const inDialog = target?.inDialog === true;
  const isSafeDismiss =
    SAFE_DISMISS_PATTERN.test(label) &&
    (DECLINE_ESCAPE_PATTERN.test(label) || !DISMISS_AGREES_PATTERN.test(label));
  let hostRegex = null;
  if (context?.commitPattern instanceof RegExp) hostRegex = context.commitPattern;
  else if (typeof context?.commitPattern === "string" && context.commitPattern)
    try {
      hostRegex = new RegExp(context.commitPattern, "iu");
    } catch {
      hostRegex = null;
    }
  const hostCommit = !!hostRegex?.test(label);
  const wordCommit =
    !isSafeDismiss &&
    !(inDialog && /^cancel$/i.test(label)) &&
    COMMIT_CONTROL.test(label);
  const isSubmits =
    target?.submits === true ||
    (tag === "input" && ["submit", "image"].includes(type));
  const submitCommit =
    isSubmits &&
    (target?.inFormWithPayment === true ||
      target?.inFormWithPassword === true ||
      wordCommit ||
      hostCommit ||
      !SAFE_FORM_STEP_PATTERN.test(label));
  const isInert =
    target?.inert === true ||
    (target?.inert !== false &&
      ((tag === "input" && ["checkbox", "radio"].includes(type)) ||
        ["checkbox", "radio", "switch", "option", "tab"].includes(role) ||
        tag === "summary" ||
        (tag === "a" && target?.hasHref === true)));
  const paymentPageLock =
    context?.hasPaymentCredentialField === true && !isInert;
  if (wordCommit) reasons.push("commit-label");
  if (hostCommit) reasons.push("host-commit-pattern");
  if (submitCommit) reasons.push("form-submit");
  if (paymentPageLock) reasons.push("payment-credential-page");
  if (reasons.length > 0)
    return { consequence: "commit", reasons, requiresGrant: true };
  if (
    tag === "summary" ||
    target?.discloses === true ||
    isSafeDismiss ||
    (inDialog && /^cancel$/i.test(label))
  )
    return {
      consequence: "observe",
      reasons: ["disclosure-or-dismiss"],
      requiresGrant: false,
    };
  if (
    tag === "select" ||
    tag === "textarea" ||
    target?.contentEditable === true ||
    (tag === "input" &&
      !["button", "submit", "reset", "image"].includes(type)) ||
    [
      "checkbox",
      "radio",
      "switch",
      "option",
      "combobox",
      "listbox",
      "radiogroup",
      "spinbutton",
      "slider",
      "textbox",
      "searchbox",
    ].includes(role) ||
    STAGE_CONTROL_PATTERN.test(label)
  )
    return {
      consequence: "stage",
      reasons: ["reversible-stage"],
      requiresGrant: false,
    };
  return {
    consequence: "navigate",
    reasons: ["navigation-or-routine"],
    requiresGrant: false,
  };
}

/**
 * Selects the highest-priority safely dismissible blocker from a snapshot
 * (cookie-consent `rejectRef` or non-agreeing modal `ref`, never captcha or
 * accepting consent) and builds a click command targeting it.
 */
export function dismissBlockerCommand(snapshot, options = {}) {
  const frameId = options?.frameId ?? 0;
  const preferReject = options?.preferReject !== false;
  const blockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers : [];
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const snapshotId =
    typeof snapshot?.snapshotId === "string" ? snapshot.snapshotId : undefined;
  const rank = { viewport: 0, target: 1, partial: 2 };
  const ordered = blockers
    .map((blocker, blockerIndex) => ({ blocker, blockerIndex }))
    .sort(
      (left, right) =>
        (rank[left.blocker?.covers] ?? 3) - (rank[right.blocker?.covers] ?? 3),
    );
  const findElement = (ref) => {
    if (typeof ref !== "string" || !ref) return null;
    return (
      elements.find(
        (element) =>
          element.id === ref ||
          element.selector === ref ||
          (snapshotId && `${snapshotId}:${frameId}:${element.id}` === ref),
      ) ?? null
    );
  };
  for (const { blocker, blockerIndex } of ordered) {
    if (!blocker || blocker.kind === "captcha" || blocker.kind === "paywall")
      continue;
    const candidateRef =
      blocker.kind === "cookie-consent"
        ? preferReject
          ? blocker.rejectRef
          : undefined
        : blocker.ref;
    if (!candidateRef) continue;
    const element = findElement(candidateRef);
    if (!element || element.disabled) continue;
    const label = String(element.label ?? "").trim();
    if (
      blocker.kind !== "cookie-consent" &&
      DISMISS_AGREES_PATTERN.test(label) &&
      !DECLINE_ESCAPE_PATTERN.test(label)
    )
      continue;
    if (
      element.consequence === "commit" &&
      blocker.kind !== "cookie-consent" &&
      !DECLINE_ESCAPE_PATTERN.test(label)
    )
      continue;
    const nodeId =
      typeof element.id === "string"
        ? element.id
        : typeof element.selector === "string"
          ? element.selector.split(":").at(-1)
          : undefined;
    const selector =
      typeof element.selector === "string"
        ? element.selector
        : snapshotId && nodeId !== undefined
          ? `${snapshotId}:${frameId}:${nodeId}`
          : undefined;
    return {
      blocker,
      blockerIndex,
      element,
      command: {
        subaction: "click",
        ...(snapshotId ? { snapshotId } : {}),
        ...(nodeId !== undefined ? { nodeId } : {}),
        ...(selector ? { selector } : {}),
        ...(element.targetSelector
          ? { expectedSelector: element.targetSelector }
          : {}),
      },
    };
  }
  return null;
}
