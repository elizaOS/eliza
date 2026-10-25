/** Executes fixed browser operations against explicit tabs and isolated-world snapshot references. */
import { BridgeError } from "./protocol.mjs";

/**
 * Words on a control that commits a payment, sign-in, submission or other
 * irreversible step. A task policy can never click such a control; the person
 * presses it. Products that plan clicks should use this same vocabulary.
 */
export const COMMIT_CONTROL =
  /\b(pay|pays|paying|payments?|submit|confirm|sign\s*in|log\s*in|sign\s*up|verify|send|delete|remove|cancel|close\s+account|authori[sz]e|agree|accept|save|continue|proceed|buy|purchase|place\s+(?:my\s+|your\s+|the\s+)?order|order\s+now|check\s*out|schedule|transfer|donate|subscribe)\b/i;

export function pageCommand(command, snapshotId, validateOnly = false) {
  const policy = command.taskPolicy;
  const denied = () => ({
    error: {
      kind: "POLICY_BLOCKED",
      message:
        "This action requires the person or a new authorized task observation.",
    },
  });
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
  let monitor = globalThis[monitorKey];
  if (!monitor || monitor.document !== document) {
    monitor = {
      document,
      domRevision: 0,
      inputRevision: 0,
      ownedHosts: new WeakSet(),
      editedFields: new WeakSet(),
    };
    monitor.recordMutations = (records) => {
      if (
        records.some(
          (record) =>
            !(
              record.type === "childList" &&
              record.target === document.documentElement &&
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
    monitor.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const input = (event) => {
      monitor.inputRevision++;
      if (
        ["input", "change"].includes(event?.type) &&
        event.target instanceof Element
      )
        monitor.editedFields.add(event.target);
    };
    document.addEventListener("beforeinput", input, true);
    document.addEventListener("input", input, true);
    document.addEventListener("change", input, true);
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) input();
      },
      true,
    );
    globalThis[monitorKey] = monitor;
  }
  // Drain queued mutations synchronously as an effect may arrive before the
  // MutationObserver microtask. Never store or return form values in this monitor.
  monitor.recordMutations(monitor.observer.takeRecords());
  const bounds = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
          ? getComputedStyle(node.parentElement).visibility
          : "visible";
        if (
          visibility !== "hidden" &&
          visibility !== "collapse" &&
          node.textContent.trim()
        )
          visibleText.push(node.textContent);
        return;
      }
      if (!(node instanceof Element)) return;
      if (
        node.matches("input,textarea,select,script,style,noscript") ||
        node.isContentEditable
      )
        return;
      const style = getComputedStyle(node);
      if (style.display === "none") return;
      if (node instanceof HTMLDetailsElement && !node.open) {
        const summary = node.querySelector(":scope > summary");
        if (summary) collectText(summary);
        return;
      }
      for (const child of node.childNodes) collectText(child);
    };
    collectText(root);
    return visibleText.join("\n").trim();
  };
  // Accessible name in the usual order. Never reads a form control value
  // except the visible caption of a button-type input.
  const idText = (value) =>
    (value || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id))
      .filter(Boolean)
      .map((ref) => readVisibleText(ref) || ref.getAttribute("aria-label"))
      .filter(Boolean)
      .join(" ")
      .trim();
  const accessibleName = (node) => {
    const labelled = idText(node.getAttribute("aria-labelledby"));
    if (labelled) return labelled;
    const aria = node.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const labels = [...(node.labels ?? [])]
      .map((label) => readVisibleText(label))
      .filter(Boolean)
      .join(" ");
    if (labels) return labels;
    if (
      node instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(node.type)
    )
      return node.value || (node.type === "submit" ? "Submit" : "");
    if (node instanceof HTMLInputElement && node.type === "image")
      return node.alt || node.title || "";
    if (node instanceof HTMLInputElement && node.type === "password")
      return node.getAttribute("placeholder") || node.title || "Password";
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement ||
      node.isContentEditable
    )
      return node.getAttribute("placeholder") || node.title || "";
    return readVisibleText(node) || node.title || "";
  };
  // Marks fields whose value is a secret. The value itself is never read.
  // The field's type and autocomplete tokens decide first. A field that the
  // page does not mark is classified by its name, its id, its placeholder and
  // its accessible name, for example "Social Security number" or
  // "routingNumber". A task never fills such a field and a host never shows
  // it to a model.
  const sensitivity = (node) => {
    if (
      !(
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement ||
        node.isContentEditable
      )
    )
      return null;
    const autocomplete = (node.getAttribute("autocomplete") || "")
      .toLowerCase()
      .split(/\s+/);
    if (
      (node instanceof HTMLInputElement && node.type === "password") ||
      autocomplete.some((token) => token.endsWith("password"))
    )
      return "password";
    if (autocomplete.includes("one-time-code")) return "one-time-code";
    if (autocomplete.some((token) => token.startsWith("cc-")))
      return "payment-card";
    const words = [
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
    if (
      /\b(?:one\s*time\s*(?:pass)?code|verification\s+code|otp|2fa|mfa|passcode|authentication\s+code)\b/i.test(
        words,
      )
    )
      return "one-time-code";
    if (
      /\b(?:card\s*(?:number|no)|credit\s+card|debit\s+card|cvv2?|cvc|csc|security\s+code|expir(?:y|ation)\s*(?:date)?|cc\s*(?:num|number|exp))\b/i.test(
        words,
      )
    )
      return "payment-card";
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
  if (command.subaction === "snapshot") {
    const controlState = (node) => {
      const flag = (name) => node.getAttribute(name) === "true";
      return {
        focused: document.activeElement === node,
        disabled: node.matches(":disabled") || flag("aria-disabled"),
        ...(node instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(node.type)
          ? { checked: node.checked }
          : node.hasAttribute("aria-checked")
            ? { checked: flag("aria-checked") }
            : {}),
        ...(node.hasAttribute("aria-expanded")
          ? { expanded: flag("aria-expanded") }
          : {}),
        required: node.required === true || flag("aria-required"),
        invalid: flag("aria-invalid"),
        // Field help and error text the page ties to this control.
        description:
          [
            idText(node.getAttribute("aria-describedby")),
            flag("aria-invalid")
              ? idText(node.getAttribute("aria-errormessage"))
              : "",
          ]
            .filter(Boolean)
            .join(" ") || null,
        sensitive: sensitivity(node),
        ...(node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement ||
        node.isContentEditable
          ? { edited: monitor.editedFields.has(node) }
          : {}),
        // A select can have a valid choice whose internal value is empty.
        // Only selection/occupancy leaves the page, never the field value.
        ...(node instanceof HTMLSelectElement
          ? {
              hasInput:
                node.selectedIndex >= 0 &&
                !node.validity.valueMissing &&
                !node.options[node.selectedIndex].disabled &&
                (node.value !== "" || monitor.editedFields.has(node)),
            }
          : (node instanceof HTMLInputElement &&
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
              node instanceof HTMLTextAreaElement
            ? { hasInput: node.value !== "" }
            : node.isContentEditable
              ? { hasInput: (node.textContent ?? "").trim() !== "" }
              : {}),
      };
    };
    // A page can copy what was typed in a secret field into its own text, its
    // title or a control's name. The values are compared here, in the page, and
    // every copy is replaced before anything is returned. Very short values are
    // not compared: they would match ordinary words.
    const secrets = [
      ...new Set(
        [...document.querySelectorAll("input,textarea")]
          .filter((node) => sensitivity(node) !== null)
          .map((node) => node.value)
          .filter((value) => typeof value === "string" && value.length >= 4),
      ),
    ].sort((left, right) => right.length - left.length);
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
      "a,button,input,textarea,select,summary,[contenteditable=true],[role=button],[role=link],[role=textbox],[role=searchbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=spinbutton],[role=slider]";
    // A page can also make a plain element pressable with an inline click
    // handler, a tab stop or a pointer cursor, often with no name at all.
    // The commit guard treats the same signals as a control. Only the
    // outermost such element that holds no native control is listed.
    // One pass in document order. The cheap attribute test runs before the
    // style and subtree tests, and an element inside a listed custom control
    // is skipped by its ancestor, so a large page stays linear.
    const custom = new Set();
    const candidates = [];
    for (const node of (
      document.body ?? document.documentElement
    ).querySelectorAll("*")) {
      if (node.matches(NATIVE)) {
        candidates.push(node);
        continue;
      }
      if (
        !(
          node.matches('[onclick],[tabindex]:not([tabindex="-1"])') ||
          (getComputedStyle(node).cursor === "pointer" &&
            getComputedStyle(node.parentElement ?? node).cursor !== "pointer")
        ) ||
        node.closest(NATIVE) ||
        node.querySelector(NATIVE)
      )
        continue;
      let inside = false;
      for (
        let item = node.parentElement;
        item && !inside;
        item = item.parentElement
      )
        inside = custom.has(item);
      if (inside) continue;
      custom.add(node);
      candidates.push(node);
    }
    // The last visible line of text before a control, looked for among its
    // earlier siblings and then its ancestors' earlier siblings. It names a
    // control that has no label ("Search" beside an empty input) and tells
    // repeated labels apart (the row text before each "Pay").
    const nearbyText = (node) => {
      for (
        let item = node, depth = 0;
        item && item !== document.body && depth < 4;
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
              : sibling instanceof Element
                ? readVisibleText(sibling)
                : "";
          if (text) return text.split("\n").filter(Boolean).at(-1).trim();
        }
      return null;
    };
    // The form or field group the control belongs to, by its own name.
    const groupName = (group) =>
      group
        ? idText(group.getAttribute("aria-labelledby")) ||
          group.getAttribute("aria-label")?.trim() ||
          (group.querySelector("legend,h1,h2,h3,h4,h5,h6")
            ? readVisibleText(group.querySelector("legend,h1,h2,h3,h4,h5,h6"))
            : "") ||
          null
        : null;
    const forms = [...document.forms];
    // Position of an element among its siblings with the same tag, counted
    // once per parent.
    const typeIndexes = new Map();
    const typeIndex = (item) => {
      if (!typeIndexes.has(item)) {
        const counts = {};
        for (const sibling of item.parentElement?.children ?? [item]) {
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
      const unique = (selector) => {
        try {
          return (
            selector.length <= 256 &&
            document.querySelectorAll(selector).length === 1 &&
            document.querySelector(selector) === node
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
      for (
        let item = node;
        item && item !== document.documentElement;
        item = item.parentElement
      ) {
        if (item !== node && item.id && unique(`#${CSS.escape(item.id)}`)) {
          path.unshift(`#${CSS.escape(item.id)}`);
          break;
        }
        path.unshift(
          `${item.tagName.toLowerCase()}:nth-of-type(${typeIndex(item)})`,
        );
      }
      const selector = path.join(" > ");
      try {
        return selector.length <= 256 && node.matches(selector)
          ? selector
          : null;
      } catch {
        return null;
      }
    };
    for (const node of candidates) {
      if (!node.checkVisibility({ checkVisibilityCSS: true })) continue;
      const id = String(nodes.size);
      const geometry = bounds(node);
      // This equality sentinel never leaves the isolated page realm.
      nodes.set(id, {
        node,
        bounds: geometry,
        value: typeof node.value === "string" ? node.value : null,
      });
      const state = controlState(node);
      const form = node.form ?? node.closest("form");
      const hint = (value) => withoutSecrets(value?.trim() || null);
      elements.push({
        bounds: geometry,
        id,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        label: withoutSecrets(accessibleName(node)),
        type: node.getAttribute("type"),
        ...state,
        description: withoutSecrets(state.description),
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
        form: form
          ? { index: forms.indexOf(form), name: hint(groupName(form)) }
          : null,
        group: hint(groupName(node.closest("fieldset,[role=group]"))),
        // A button that sends its form when pressed.
        submits:
          (node instanceof HTMLButtonElement ||
            node instanceof HTMLInputElement) &&
          node.form !== null &&
          ["submit", "image"].includes(node.type),
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
          geometry.y + geometry.height > 0,
        targetSelector: uniqueSelector(node),
        heading: node.querySelector("h1,h2,h3,h4,h5,h6")
          ? withoutSecrets(
              readVisibleText(node.querySelector("h1,h2,h3,h4,h5,h6")),
            )
          : null,
        href:
          node instanceof HTMLAnchorElement && /^https?:/.test(node.href)
            ? node.href
            : null,
      });
    }
    globalThis[key] = {
      snapshotId,
      nodes,
      document,
      url: location.href,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
    };
    // A submit or page change that a task fill or click set off in this
    // document, under this binding. The watch below stopped it.
    const violation = globalThis[watchKey]?.violation;
    return {
      ...(policy && violation && violation.scope === policy.guidanceScope
        ? { effectViolation: violation.kind }
        : {}),
      url: location.href,
      title: withoutSecrets(document.title),
      readyState: document.readyState,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
      text: withoutSecrets(
        readVisibleText(document.body ?? document.documentElement),
      ),
      complete: true,
      omitted: [
        "form control values and editable region contents (credential boundary)",
        "page text, title and control names equal to the value of a password, code or card field",
      ],
      elements,
    };
  }
  const state = globalThis[key];
  if (
    !state ||
    state.snapshotId !== command.snapshotId ||
    state.document !== document ||
    state.url !== location.href ||
    state.domRevision !== monitor.domRevision ||
    state.inputRevision !== monitor.inputRevision ||
    JSON.stringify(state.viewport) !== JSON.stringify(viewport())
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
    recorded.value !== (typeof node.value === "string" ? node.value : null) ||
    JSON.stringify(recorded.bounds) !== JSON.stringify(bounds(node))
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "The referenced page element changed; read a fresh snapshot.",
      },
    };
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
          const matches = document.querySelectorAll(target.selector);
          return matches.length === 1 && matches[0] === node;
        } catch {
          return false;
        }
      })
    )
      return denied();
    const label = [
      accessibleName(node),
      node.getAttribute("aria-label"),
      node.textContent,
      node.title,
      node instanceof HTMLInputElement ? node.value : "",
      ...[...(node.labels ?? [])].map((item) => item.textContent),
    ].join(" ");
    // A control that commits something stays with the person, whatever its
    // element or role. Keep this literal equal to COMMIT_CONTROL above; the
    // function runs in the page, so it cannot read a module constant.
    if (
      command.subaction === "click" &&
      (node.matches(
        "button:not([type=button]):not([type=reset]),input[type=submit],input[type=image],input[type=password]",
      ) ||
        /\b(pay|pays|paying|payments?|submit|confirm|sign\s*in|log\s*in|sign\s*up|verify|send|delete|remove|cancel|close\s+account|authori[sz]e|agree|accept|save|continue|proceed|buy|purchase|place\s+(?:my\s+|your\s+|the\s+)?order|order\s+now|check\s*out|schedule|transfer|donate|subscribe)\b/i.test(
          label,
        ))
    )
      return denied();
    if (
      command.subaction === "fill" &&
      (!(
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) ||
        (node instanceof HTMLInputElement &&
          !["text", "email", "tel", "number", "search", "url", "date"].includes(
            node.type,
          )) ||
        // A date field takes only a real calendar day, as YYYY-MM-DD.
        (node instanceof HTMLInputElement &&
          node.type === "date" &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(command.text) ||
            command.text.startsWith("0000-") ||
            Number.isNaN(Date.parse(`${command.text}T00:00:00Z`)) ||
            new Date(`${command.text}T00:00:00Z`).toISOString().slice(0, 10) !==
              command.text)) ||
        (policy.protectedValueKind === "verification-code"
          ? !(node instanceof HTMLInputElement) ||
            node.autocomplete !== "one-time-code" ||
            !/^[A-Za-z0-9]{4,12}$/.test(command.text)
          : sensitivity(node) !== null))
    )
      return denied();
  }
  if (command.subaction === "fill" && (node.disabled || node.readOnly))
    return denied();
  // A control the provider disabled stays as the provider left it. A script
  // click on an aria-disabled control would still run the page's handlers.
  if (
    policy &&
    command.subaction === "click" &&
    node.matches(':disabled,[aria-disabled="true"]')
  )
    return denied();
  if (validateOnly) return { validated: true };
  if (policy?.actionId) {
    const feedback = globalThis.__elizaPageGuidanceV1;
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
  delete globalThis[key];
  if (policy && ["click", "fill"].includes(command.subaction)) {
    // A task fill or click must not submit a form or leave the page, also
    // not through the page's own script (an auto-submitting code field, or
    // a button that calls form.submit()). For 30 seconds, or until the next
    // task fill or click, watch what the page does before the person takes
    // over by activating a control:
    // - a form submit or a page change to another document is stopped,
    //   except a click on a link that opens that link;
    // - a same-document address change (history.pushState) is recorded;
    // - a fetch, XMLHttpRequest or beacon to the page's own site is recorded.
    //   It cannot be stopped from here and may already have committed
    //   something (a code field that verifies itself with fetch).
    // Snapshots report the first of these, so the host treats the outcome as
    // unknown and pauses the task. A request still in flight when a snapshot
    // is read shows up in a later snapshot.
    globalThis[watchKey]?.stop();
    const anchor =
      command.subaction === "click" ? node.closest("a[href]") : null;
    let personAt = Number.NEGATIVE_INFINITY;
    let activationAt = Number.POSITIVE_INFINITY;
    const startedAt = performance.now();
    const controller = new AbortController();
    const watch = {
      violation:
        globalThis[watchKey]?.violation?.scope === policy.guidanceScope
          ? (globalThis[watchKey]?.violation ?? null)
          : null,
      stop: () => controller.abort(),
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
    const person = (event) => {
      if (event.isTrusted) personAt = performance.now();
    };
    const personForms = new WeakSet();
    window.addEventListener("pointerdown", person, options);
    window.addEventListener("keydown", person, options);
    const activate = (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
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
            (item === target && getComputedStyle(item).cursor === "pointer")
          ) {
            if (!item.matches('[aria-disabled="true"]')) personForms.add(form);
            break;
          }
        }
      }
      const enterForm =
        event.key === "Enter" &&
        target instanceof HTMLInputElement &&
        target.form;
      const controlKey =
        control &&
        !field &&
        (event.key === "Enter" ||
          (event.key === " " && !control.matches('a[href],[role="link"]')));
      if (keyboard ? !controlKey && !enterForm : !control) return;
      activationAt = Math.min(activationAt, performance.now());
    };
    window.addEventListener("click", activate, options);
    window.addEventListener("keydown", activate, options);
    window.addEventListener(
      "submit",
      (event) => {
        if (!personForms.has(event.target)) report("submit", event);
      },
      options,
    );
    globalThis.navigation?.addEventListener(
      "navigate",
      (event) => {
        if (
          event.userInitiated ||
          (anchor &&
            !event.formData &&
            event.destination.url === anchor.href) ||
          personForms.has(event.sourceElement?.form ?? event.sourceElement)
        )
          return;
        if (event.destination.sameDocument) {
          // Recorded, not stopped: the page's own state has already moved.
          if (!byPerson(performance.now())) record("navigation");
          return;
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
    if (typeof PerformanceObserver === "function") {
      const requests = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            entry.startTime < startedAt ||
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
            record("request");
            break;
          }
        }
      });
      requests.observe({ type: "resource" });
      controller.signal.addEventListener("abort", () => requests.disconnect());
    }
    setTimeout(() => controller.abort(), 30000);
    globalThis[watchKey] = watch;
  }
  if (command.subaction === "click") {
    node.click();
  } else if (command.subaction === "fill") {
    if (
      !(
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) ||
      node.disabled ||
      node.readOnly
    )
      return {
        error: {
          kind: "UNSUPPORTED",
          message: "The target is not an editable form control.",
        },
      };
    const prototype =
      node instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      node,
      command.text,
    );
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
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
  return { dispatched: true, completed: false, requiresReadback: true };
}

/** Resolves required browser context without admitting or performing an effect. */
export async function prepareCommand(api, command) {
  if (command.subaction !== "open") return {};
  const windows = (
    await api.windows.getAll({ windowTypes: ["normal"] })
  ).filter((window) => window.type === "normal" && Number.isInteger(window.id));
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  if (!window)
    throw new BridgeError(
      "UNAVAILABLE",
      "Open Chromium from your launcher once, then request a new background tab. No browser window is available; this command was not performed.",
    );
  return { windowId: window.id };
}

export async function executeCommand(
  api,
  command,
  prepared,
  isCurrent = () => true,
) {
  const requireCurrent = () => {
    if (!isCurrent())
      throw new BridgeError(
        "STALE_REF",
        "The browser command context ended before dispatch; observe again under the current context.",
      );
  };
  const read = async (operation) => {
    requireCurrent();
    const value = await operation();
    requireCurrent();
    return value;
  };
  const effect = async (operation) => {
    requireCurrent();
    const value = await operation();
    if (!isCurrent())
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "The browser command context ended after dispatch; inspect the same tab without replaying the effect.",
      );
    return value;
  };
  requireCurrent();
  const action = command.subaction;
  if (action === "list") {
    const all = await read(() => api.tabs.query({}));
    return {
      tabs: all
        .filter((tab) => /^https?:/.test(tab.url ?? ""))
        .map((tab) => ({
          id: String(tab.id),
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
        })),
      // Windows counted before the filter: a window that holds only a new-tab,
      // settings or PDF page is still a window she may be looking at.
      windowCount: new Set(all.map((tab) => tab.windowId)).size,
    };
  }
  if (action === "open") {
    const context =
      prepared ?? (await read(() => prepareCommand(api, command)));
    const tab = await effect(() =>
      api.tabs.create({
        url: command.url,
        active: false,
        windowId: context.windowId,
      }),
    );
    return {
      id: String(tab.id),
      dispatched: true,
      completed: false,
      requiresReadback: true,
    };
  }
  const tabId = Number(command.id);
  let tab = await read(() => api.tabs.get(tabId));
  if (action === "snapshot") {
    const deadline = Date.now() + 15000;
    while (
      (!/^https?:/.test(tab.url ?? "") || tab.status === "loading") &&
      /^https?:/.test(tab.pendingUrl ?? tab.url ?? "") &&
      Date.now() < deadline
    ) {
      await read(() => new Promise((resolve) => setTimeout(resolve, 50)));
      tab = await read(() => api.tabs.get(tabId));
    }
    if (tab.status === "loading")
      throw new BridgeError(
        "UNAVAILABLE",
        "The exact browser tab is still loading; read it again without repeating navigation.",
      );
  }
  if (!/^https?:/.test(tab.url ?? ""))
    throw new BridgeError(
      "POLICY_BLOCKED",
      "Browser-internal pages cannot be controlled.",
    );
  if (action === "navigate")
    await effect(() => api.tabs.update(tabId, { url: command.url }));
  else if (action === "close") await effect(() => api.tabs.remove(tabId));
  else if (action === "back") await effect(() => api.tabs.goBack(tabId));
  else if (action === "forward") await effect(() => api.tabs.goForward(tabId));
  else if (action === "reload") await effect(() => api.tabs.reload(tabId));
  else if (action === "snapshot") {
    const snapshotId = crypto.randomUUID();
    const before = (
      await read(() => api.webNavigation.getAllFrames({ tabId }))
    )?.filter((frame) => !command.taskPolicy || frame.frameId === 0);
    if (
      !before?.length ||
      before.some((frame) => frame.errorOccurred || !frame.documentId)
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "The browser could not inventory every frame document.",
      );
    const frames = await read(() =>
      api.scripting.executeScript({
        target: command.taskPolicy
          ? { tabId, frameIds: [0] }
          : { tabId, allFrames: true },
        func: pageCommand,
        args: [command, snapshotId],
        world: "ISOLATED",
      }),
    );
    const after = (
      await read(() => api.webNavigation.getAllFrames({ tabId }))
    )?.filter((frame) => !command.taskPolicy || frame.frameId === 0);
    if (
      !after ||
      before.length !== after.length ||
      frames.length !== before.length ||
      before.some(
        (frame) =>
          !after.some(
            (current) =>
              current.frameId === frame.frameId &&
              current.documentId === frame.documentId,
          ) ||
          !frames.some(
            (read) =>
              read.frameId === frame.frameId &&
              read.documentId === frame.documentId,
          ),
      )
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "A frame was inaccessible or changed during the read; no partial snapshot is returned.",
      );
    return {
      id: command.id,
      snapshotId,
      frames: frames.map(({ frameId, documentId, result, error }) => {
        if (error || !result?.complete)
          throw new BridgeError(
            "INCOMPLETE_SNAPSHOT",
            "A frame could not be read completely; no partial snapshot is returned.",
          );
        return {
          frameId,
          documentId,
          ...result,
          elements: result.elements.map(({ id, ...element }) => ({
            ...element,
            selector: `${snapshotId}:${frameId}:${id}`,
          })),
        };
      }),
    };
  } else {
    const match = /^([0-9a-f-]{36}):(\d+):(\d+)$/.exec(command.selector);
    if (!match)
      throw new BridgeError(
        "STALE_REF",
        "Use a selector from the latest snapshot.",
      );
    const [result] = await effect(() =>
      api.scripting.executeScript({
        target: { tabId, frameIds: [Number(match[2])] },
        func: pageCommand,
        args: [{ ...command, snapshotId: match[1], nodeId: match[3] }, null],
        world: "ISOLATED",
      }),
    );
    if (result?.result?.error)
      throw new BridgeError(
        result.result.error.kind,
        result.result.error.message,
      );
    if (!result?.result?.dispatched)
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "No effect receipt arrived; inspect the same tab before retrying.",
      );
    return result.result;
  }
  return {
    id: command.id,
    dispatched: true,
    completed: false,
    requiresReadback: true,
  };
}
