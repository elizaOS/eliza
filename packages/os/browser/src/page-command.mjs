/** Fixed DOM operations shared by Chromium and embedded native pages. No host imports. */
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
      globalThis[grantKey]?.document === document &&
      globalThis[grantKey].used.has(policy.commitGrant.grantId)
    )
      ? policy.commitGrant
      : null;
  if (policy?.commitGrant && !grant && command.subaction !== "snapshot")
    return denied();
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
    if (node === document.scrollingElement)
      return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const scrollState = (node) => {
    const root = node === document.scrollingElement;
    const style = getComputedStyle(node);
    const width = root ? innerWidth : node.clientWidth;
    const height = root ? innerHeight : node.clientHeight;
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
    if (document.scrollingElement && scrollState(document.scrollingElement))
      candidates.push(document.scrollingElement);
    for (const node of (
      document.body ?? document.documentElement
    ).querySelectorAll("*")) {
      if (node.matches(NATIVE)) {
        candidates.push(node);
        continue;
      }
      const scrollable = scrollState(node) !== null;
      if (
        !(
          node.matches('[onclick],[tabindex]:not([tabindex="-1"])') ||
          (getComputedStyle(node).cursor === "pointer" &&
            getComputedStyle(node.parentElement ?? node).cursor !== "pointer")
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
      if (node === document.documentElement) return "html";
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
      const scroll = scrollState(node);
      const scrollOnly = !!scroll && !node.matches(NATIVE) && !custom.has(node);
      // This equality sentinel never leaves the isolated page realm.
      nodes.set(id, {
        node,
        bounds: geometry,
        href: node instanceof HTMLAnchorElement ? node.href : null,
        scroll,
        scrollOnly,
        value: typeof node.value === "string" ? node.value : null,
        selection:
          node instanceof HTMLSelectElement ? node.selectedIndex : null,
      });
      const state = controlState(node);
      const form = node.form ?? node.closest("form");
      const hint = (value) => withoutSecrets(value?.trim() || null);
      elements.push({
        bounds: geometry,
        id,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        label: withoutSecrets(
          scrollOnly
            ? scroll.document
              ? "Page"
              : groupName(node) || "Scrollable region"
            : accessibleName(node),
        ),
        ...(scroll ? { scroll, scrollOnly } : {}),
        type: node.getAttribute("type"),
        ...state,
        description: withoutSecrets(state.description),
        // Option labels are page-authored choices, not internal option values.
        ...(node instanceof HTMLSelectElement && sensitivity(node) === null
          ? {
              options: [...node.options].map((option) => ({
                label: hint(option.label.replace(/\s+/g, " ")),
                disabled:
                  option.disabled || option.parentElement?.disabled === true,
                selected: option.selected,
              })),
            }
          : {}),
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
      const owned = (node) => {
        for (let item = node; item; item = item.parentElement)
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
                  !node.contains(nodes.get(element.id).node),
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
          item = item.parentElement
        )
          if (getComputedStyle(item).position === "fixed" && !shell(item))
            layer = item;
        return layer;
      };
      const GRID = 9;
      const hits = [];
      for (let row = 0; row < GRID; row++)
        for (let column = 0; column < GRID; column++) {
          const hit = document.elementFromPoint(
            ((column + 0.5) * innerWidth) / GRID,
            ((row + 0.5) * innerHeight) / GRID,
          );
          if (hit && !owned(hit)) hits.push(hit);
        }
      const share = (root) =>
        hits.filter((hit) => root.contains(hit)).length / (GRID * GRID);
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
        /^(?:close|dismiss|no,? thanks|not now|maybe later|skip|×|✕|✖|x)$|^close\b/i;
      // A "Close and accept" or "Dismiss and continue" control agrees to
      // something; it is never offered as the way out.
      const AGREES =
        /\b(?:accept|agree|allow|consent|ok(?:ay)?|got it|continue|subscribe|sign|log|buy|pay|confirm)\b/i;
      // An invisible reCAPTCHA or hCaptcha is bound to a page's own button
      // and is not in the way until the site shows a challenge.
      const captchas = [...document.querySelectorAll(CAPTCHA)].filter(
        (node) =>
          !node.matches("button,input,a,[data-size=invisible]") &&
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
      for (const node of [
        ...document.querySelectorAll(`${DIALOG},${CONSENT}`),
        ...captchas,
      ])
        if (
          visible(node) &&
          !node.matches(
            "a,button,input,select,textarea,[role=button],[role=link]",
          )
        ) {
          const layer = layerOf(node);
          add(layer ?? node, { overlay: !!layer || node.matches(DIALOG) });
        }
      // A sign-in wall, paywall or person check written into the page itself.
      const walker = document.createTreeWalker(
        document.body ?? document.documentElement,
        NodeFilter.SHOW_TEXT,
      );
      const inline = new Set();
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
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
        inline.add(kind);
        const root =
          parent.closest(
            `${DIALOG},form,section,article,aside,main,[role=main]`,
          ) ?? parent;
        add(layerOf(root) ?? root, {
          overlay: !!layerOf(root),
          kind,
          text: words.trim(),
        });
      }
      const result = [];
      for (const [root, found] of roots) {
        // One report per blocker: an inner element of another is part of it.
        if (
          [...roots.keys()].some(
            (other) => other !== root && other.contains(root),
          )
        )
          continue;
        const has = (selector) =>
          root.matches(selector) || !!root.querySelector(selector);
        const text = textOf(root);
        const dialog = has(DIALOG);
        const kind =
          found.kind === "captcha" ||
          captchas.some((node) => root.contains(node)) ||
          CAPTCHA_TEXT.test(text)
            ? "captcha"
            : has(CONSENT)
              ? "cookie-consent"
              : found.kind === "login-wall" ||
                  [...root.querySelectorAll("input[type=password]")].some(
                    visible,
                  ) ||
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
        if (modal || share(root) >= 0.5) covers = "viewport";
        else if (
          !found.overlay &&
          kind !== "modal" &&
          kind !== "cookie-consent" &&
          pageText.length - readVisibleText(root).length < 300
        )
          // The page is little more than this wall: an interstitial.
          covers = "viewport";
        else if (
          [...nodes.values()].some(({ node, bounds: box, scrollOnly }) => {
            if (scrollOnly || root.contains(node) || node.contains(root))
              return false;
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
              return false;
            const hit = document.elementFromPoint(x, y);
            return !!hit && root.contains(hit);
          })
        )
          covers = "target";
        const control = (pattern) => {
          for (const [node, id] of idOf)
            if (
              root.contains(node) &&
              node !== root &&
              pattern.test((labelOf.get(id) ?? "").trim()) &&
              (pattern === REJECT ||
                !AGREES.test((labelOf.get(id) ?? "").trim()))
            )
              return id;
          return undefined;
        };
        const ref =
          kind === "captcha" || kind === "cookie-consent"
            ? undefined
            : control(CLOSE);
        const rejectRef =
          kind === "cookie-consent" ? control(REJECT) : undefined;
        const summary = (found.text ?? text).slice(0, 200);
        result.push({
          kind,
          ...(ref !== undefined ? { ref } : {}),
          ...(rejectRef !== undefined ? { rejectRef } : {}),
          covers,
          ...(summary ? { text: withoutSecrets(summary) } : {}),
        });
      }
      const rank = { viewport: 0, target: 1, partial: 2 };
      return result.sort(
        (left, right) => rank[left.covers] - rank[right.covers],
      );
    })();
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
    // The commit the person said yes to, which the watch let through once.
    const consented = globalThis[watchKey]?.consented;
    // A one-shot comparison from the actual fill, kept in this isolated realm.
    // Neither the expected text nor the field value leaves the page.
    const inputReadback = monitor.inputReadback;
    delete monitor.inputReadback;
    const clickReadback = monitor.clickReadback;
    delete monitor.clickReadback;
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
                inputReadback.node.value === inputReadback.text,
            },
          }
        : {}),
      ...(policy && violation && violation.scope === policy.guidanceScope
        ? { effectViolation: violation.kind }
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
      readyState: document.readyState,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
      text: withoutSecrets(pageText),
      blockers,
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
    recorded.selection !==
      (node instanceof HTMLSelectElement ? node.selectedIndex : null) ||
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
    // element or role, unless she said yes to this exact commit. Keep this
    // literal equal to COMMIT_CONTROL above; the function runs in the page,
    // so it cannot read a module constant.
    if (
      command.subaction === "click" &&
      !grant &&
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
  const selectedOptions =
    command.subaction === "select" && node instanceof HTMLSelectElement
      ? [...node.options].filter(
          (option) => option.label.replace(/\s+/g, " ").trim() === command.text,
        )
      : [];
  if (
    command.subaction === "select" &&
    (!(node instanceof HTMLSelectElement) ||
      node.multiple ||
      sensitivity(node) !== null ||
      selectedOptions.length !== 1 ||
      selectedOptions[0].disabled ||
      selectedOptions[0].parentElement?.disabled === true)
  )
    return denied();
  if (
    ["fill", "select"].includes(command.subaction) &&
    (node.disabled || node.readOnly)
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
      !(node instanceof HTMLAnchorElement) ||
      !node.hasAttribute("href") ||
      node.hasAttribute("download") ||
      (node.target && node.target !== "_self") ||
      node.matches('[aria-disabled="true"]') ||
      node.href !== recorded.href
    )
      return denied();
    try {
      destination = new URL(recorded.href);
      if (
        destination.protocol !== "https:" ||
        destination.origin !== policy.origin ||
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
  if (destination) {
    globalThis[watchKey]?.stop();
    location.assign(destination.href);
    return { dispatched: true, requiresReadback: true };
  }
  if (grant) {
    if (globalThis[grantKey]?.document !== document)
      globalThis[grantKey] = { document, used: new Set() };
    globalThis[grantKey].used.add(grant.grantId);
  }
  if (
    policy &&
    ["click", "fill", "select", "scroll"].includes(command.subaction)
  ) {
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
      // A receipt belongs to this dispatch, not an earlier approved action.
      consented: null,
      stop: () => controller.abort(),
    };
    // The granted control's own form: the only form the grant can send.
    const grantedForm = grant
      ? (node.form ?? node.closest("form") ?? null)
      : null;
    const submitControl = (element) =>
      (element instanceof HTMLButtonElement && element.type === "submit") ||
      (element instanceof HTMLInputElement &&
        ["submit", "image"].includes(element.type));
    const overrides = ["formaction", "formmethod", "formtarget", "formenctype"];
    // The request a submit sends: a submitter's form* attributes override
    // the form's action, method, target and encoding.
    const requestOf = (submitter, form) => {
      const own = (attribute, value, fallback) =>
        submitter?.hasAttribute(attribute) ? value : fallback;
      return {
        action: own("formaction", submitter?.formAction, form.action),
        method: own("formmethod", submitter?.formMethod, form.method),
        target: own("formtarget", submitter?.formTarget, form.target),
        enctype: own("formenctype", submitter?.formEnctype, form.enctype),
      };
    };
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
      [...document.querySelectorAll("button,input")].find(
        (element) => element.form === grantedForm && submitControl(element),
      ) === node &&
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
    const consentTo = (kind) => {
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
    // The last submit event, so the form data it sends is not taken for a
    // script form.submit(), which sends no submit event.
    let lastSubmit = null;
    window.addEventListener(
      "submit",
      (event) => {
        lastSubmit = event;
        if (personForms.has(event.target)) return;
        const form = event.target;
        const submitter = event.submitter ?? null;
        const sent =
          form instanceof HTMLFormElement ? requestOf(submitter, form) : null;
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
          consentTo("submit");
          // A page handler that cancels this submit sends no page load, so
          // none may follow it later; one own-site request still may.
          setTimeout(() => {
            if (event.defaultPrevented) consent.pending = false;
          }, 0);
          return;
        }
        report("submit", event);
      },
      options,
    );
    // A script form.submit() sends no submit event. Into this window its page
    // load is stopped below; into another window or frame (target=_blank) it
    // is not seen there, so its form data being read is reported here.
    window.addEventListener(
      "formdata",
      (event) => {
        if (reading) return;
        const form = event.target;
        const submitted =
          lastSubmit?.target === form && !lastSubmit.defaultPrevented;
        lastSubmit = null;
        if (
          submitted ||
          !(form instanceof HTMLFormElement) ||
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
    globalThis.navigation?.addEventListener(
      "navigate",
      (event) => {
        // Chromium marks the page load of a script click on a submit button
        // as user initiated; for a form submission only her own press counts.
        const formLoad =
          event.formData != null ||
          event.sourceElement instanceof HTMLFormElement ||
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
          if (!byPerson(performance.now())) record("navigation");
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
            consentTo("submit");
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
    if (typeof PerformanceObserver === "function") {
      const requests = new PerformanceObserver((list) => {
        // Oldest first, so the granted action's own request is the one used.
        const entries = [...list.getEntries()].sort(
          (a, b) => a.startTime - b.startTime,
        );
        for (const entry of entries) {
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
              consentTo("request");
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
    setTimeout(() => controller.abort(), 30000);
    globalThis[watchKey] = watch;
  }
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
    if (policy && !sensitivity(node))
      monitor.inputReadback = {
        node,
        text: command.text,
        targetRef: `${state.snapshotId}:0:${command.nodeId}`,
        scope: policy.guidanceScope,
      };
  } else if (command.subaction === "select") {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "selectedIndex",
    ).set.call(node, selectedOptions[0].index);
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
