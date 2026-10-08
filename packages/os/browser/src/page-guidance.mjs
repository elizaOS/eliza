/** Fixed isolated-world renderer. Call only from the trusted browser task host. */
export function pageGuidance(request) {
  const key = "__elizaPageGuidanceV1";
  const previous = globalThis[key];
  if (!request || typeof request !== "object") {
    previous?.destroy();
    return { visible: false, reason: "invalid-context" };
  }
  if (request.kind === "action-status")
    return {
      ready:
        previous?.actionReady?.(
          request.id,
          request.snapshotId,
          request.nodeId,
          request.action,
        ) === true,
      cancelled:
        !previous ||
        previous.id !== request.id ||
        previous.dismissed ||
        previous.disposed ||
        previous.invalidated ||
        previous.paused,
    };
  if (request.kind === "hide") {
    previous?.destroy();
    return { visible: false };
  }
  // Pause removes the ring, label and answers. Only the show-only cursor
  // stays, grey, where it was last seen. A new document has nothing to pause.
  if (request.kind === "pause") {
    if (!previous || previous.disposed)
      return { visible: false, paused: false };
    previous.pause();
    return { visible: false, paused: true };
  }
  const fail = (reason) => {
    previous?.destroy();
    return { visible: false, reason };
  };
  const answers = request.answers ?? [];
  if (
    request.kind !== "show" ||
    (request.action !== undefined &&
      !["click", "fill", "scroll"].includes(request.action)) ||
    (request.restore !== undefined && typeof request.restore !== "boolean") ||
    window !== window.top ||
    request.origin !== location.origin ||
    typeof request.id !== "string" ||
    !request.id ||
    request.id.length > 256 ||
    typeof request.text !== "string" ||
    !request.text.trim() ||
    request.text.length > 600 ||
    (request.detail !== undefined &&
      (typeof request.detail !== "string" ||
        !request.detail.trim() ||
        request.detail.length > 300)) ||
    (request.tone !== undefined &&
      !["instruction", "active", "offer", "success"].includes(request.tone)) ||
    (request.assistantName !== undefined &&
      (typeof request.assistantName !== "string" ||
        !request.assistantName.trim() ||
        request.assistantName.length > 32)) ||
    !Array.isArray(answers) ||
    answers.length > 5 ||
    answers.some(
      (answer) =>
        !answer ||
        typeof answer.id !== "string" ||
        typeof answer.text !== "string" ||
        !["card", "primary", "secondary"].includes(answer.kind) ||
        (answer.tag !== undefined && typeof answer.tag !== "string"),
    ) ||
    answers.length > 0 !== (request.tone === "offer") ||
    (answers.length > 0 &&
      (request.action !== undefined ||
        typeof request.answerKey !== "string" ||
        !request.answerKey)) ||
    (request.fonts !== undefined &&
      (!Array.isArray(request.fonts) ||
        request.fonts.some(
          (font) => !font || typeof font.data !== "string" || !font.weight,
        ))) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= Date.now() ||
    request.expiresAt > Date.now() + 300000
  )
    return fail("invalid-context");
  const snapshot = globalThis.__elizaBrowserControlV1;
  const monitor = globalThis.__elizaBrowserObservationV1;
  if (monitor && typeof monitor.recordMutations !== "function")
    return fail("stale-observation");
  monitor?.recordMutations(monitor.observer.takeRecords());
  if (
    !snapshot ||
    !monitor ||
    snapshot.snapshotId !== request.snapshotId ||
    snapshot.document !== document ||
    snapshot.url !== location.href ||
    snapshot.domRevision !== monitor.domRevision ||
    snapshot.inputRevision !== monitor.inputRevision
  )
    return fail("stale-observation");
  const target = snapshot.nodes.get(request.nodeId)?.node;
  if (!target?.isConnected || target.getRootNode() !== document)
    return fail("missing-target");
  const dismissed =
    previous?.id === request.id && previous.dismissed && !request.restore;
  // A later revision of a shown step at the same target (for example its
  // success tone) replaces the words in place: no cursor travel or slide.
  const continued =
    previous?.id === request.id &&
    previous.nodeId === request.nodeId &&
    previous.appeared === true &&
    !previous.paused;
  previous?.destroy();
  // The page shares document.fonts. Each document gets an unguessable family
  // added from bytes (no network or page CSP); any other face that claims it
  // makes the overlay use the generic system font for the rest of the document.
  const fontKey = "__elizaGuideFontV1";
  if (!globalThis[fontKey] && request.fonts?.length) {
    const family = `eliza-guide-${crypto.randomUUID()}`;
    const faces = request.fonts.map(
      (font) =>
        new FontFace(
          family,
          Uint8Array.from(atob(font.data), (c) => c.charCodeAt(0)),
          { weight: String(font.weight) },
        ),
    );
    for (const face of faces) document.fonts.add(face);
    globalThis[fontKey] = { family, faces, foreign: false };
  }
  const font = globalThis[fontKey];
  const fontFamily = () => {
    if (font && !font.foreign)
      for (const face of document.fonts)
        if (
          face.family.replace(/^["']|["']$/g, "").toLowerCase() ===
            font.family &&
          !font.faces.includes(face)
        )
          font.foreign = true;
    return font && !font.foreign
      ? `"${font.family}",system-ui,sans-serif`
      : "system-ui,sans-serif";
  };
  globalThis.__elizaGuideCursorV1 ??= {};
  const cursor = globalThis.__elizaGuideCursorV1;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const name = request.assistantName?.trim() || "Eliza";
  const initial = Array.from(name)[0].toLocaleUpperCase();
  const tone = request.action ? "active" : request.tone || "instruction";
  const host = document.createElement("div");
  host.style.cssText =
    "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ".ring{position:fixed;box-sizing:border-box;border-radius:8px;pointer-events:none;box-shadow:0 0 0 3px #fff,0 0 0 6px #4a3428}.ring.pulse{animation:ring .9s ease-in-out 3}@keyframes ring{50%{box-shadow:0 0 0 3px #fff,0 0 0 7px #4a34288c}}" +
    ".label{font:500 20px/1.4 var(--face);position:fixed;box-sizing:border-box;display:flex;flex-direction:column;gap:14px;background:#fff;color:#141414;border:2px solid #b3aad3;border-radius:16px;padding:18px;box-shadow:0 8px 24px #14141324;pointer-events:none;opacity:0;transform:translateY(-8px);transition:opacity .3s ease-out,transform .3s ease-out}.label.shown{opacity:1;transform:none;pointer-events:auto}.label.tone-success{border-color:#265b19}" +
    ".tail{position:absolute;left:28px;top:-10px;width:16px;height:16px;box-sizing:border-box;background:#fff;border:2px solid;border-color:inherit;border-right:0;border-bottom:0;transform:rotate(45deg)}.tail.up{top:auto;bottom:-10px;border:2px solid;border-color:inherit;border-left:0;border-top:0}" +
    ".row{display:flex;gap:12px;align-items:flex-start}.mark{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:#d4ceea;color:#141414;font:700 20px/1 var(--face)}.tone-active .mark{background:#b3aad3}.tone-success .mark{border-radius:17px;background:#265b19;color:#fff}" +
    ".words{display:flex;flex-direction:column;gap:4px;min-width:0}.title{margin:0;font:700 22px/28px var(--face);overflow-wrap:anywhere}.detail{margin:0;font:500 17px/22px var(--face);color:#4a3428;overflow-wrap:anywhere}" +
    "button{font:700 22px/1 var(--face);color:#141414;border:0;border-radius:20px;background:#fff;box-shadow:inset 0 0 0 1.5px #4a342899;cursor:pointer;margin:0}button:focus-visible{outline:3px solid #141414;outline-offset:3px}.answered button{cursor:default}" +
    ".cards{display:flex;flex-direction:column;gap:10px}.card{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-height:64px;padding:12px 20px;border-radius:16px;text-align:left}.value{font:700 22px/28px var(--face);overflow-wrap:anywhere}.purpose{font:500 17px/22px var(--face);color:#4a3428}" +
    ".actions{display:flex;gap:10px}.actions button{flex:1 1 0}.actions button,.close{height:64px;padding:0 28px;white-space:nowrap}.actions .primary{background:#b3aad3;box-shadow:none}[hidden]{display:none!important}" +
    ".pointer{position:fixed;left:0;top:0;width:28px;height:32px;pointer-events:none;transition:left 1.4s cubic-bezier(.45,0,.25,1),top 1.4s cubic-bezier(.45,0,.25,1)}.pointer svg{display:block;fill:#141414;filter:drop-shadow(0 2px 3px #14141359)}.tapring{position:absolute;left:-15px;top:-16px;width:36px;height:36px;box-sizing:border-box;border:4px solid #141414;border-radius:50%;opacity:0}.tapping .tapring{animation:tap .7s ease-out forwards}" +
    ".tag{position:absolute;left:24px;top:28px;display:flex;align-items:center;gap:8px;height:34px;padding:0 12px 0 8px;border-radius:9px;background:#b3aad3;color:#141414;box-shadow:0 3px 10px #14141340;font:700 18px/1 var(--face);white-space:nowrap}.initial{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;background:#141414;color:#b3aad3;font-size:12px}" +
    ".pointer.paused{transition:none}.paused svg{fill:#73726c}.paused .tag{background:#4a4a47;color:#fff}.paused .initial{background:#fff;color:#4a4a47}" +
    ".tap{position:fixed;width:36px;height:36px;border:4px solid #141414;border-radius:50%;box-sizing:border-box;pointer-events:none;animation:tap .7s ease-out forwards}@keyframes tap{0%{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}" +
    "@media (prefers-reduced-motion:reduce){.ring.pulse,.tap,.tapping .tapring{animation:none}.label,.pointer{transition:none}.label{transform:none}}";
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = element("div", "root");
  const pointer = element("div", "pointer");
  pointer.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 28 32");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "32");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M3 2 L3 26 L9 20 L14 30 L18 28 L13 18 L22 18 Z");
  arrow.setAttribute("stroke", "#fff");
  arrow.setAttribute("stroke-width", "2");
  arrow.setAttribute("stroke-linejoin", "round");
  svg.append(arrow);
  const nameTag = element("span", "name", name);
  const tag = element("span", "tag");
  tag.append(element("span", "initial", initial), nameTag);
  pointer.append(element("span", "tapring"), svg, tag);
  const tap = element("div", "tap");
  tap.setAttribute("aria-hidden", "true");
  // Reduced motion and in-place updates show everything without movement.
  const instant = reduced || continued;
  const ring = element("div", instant ? "ring" : "ring pulse");
  ring.setAttribute("aria-hidden", "true");
  const label = element(
    "section",
    `label tone-${tone}${instant ? " shown" : ""}`,
  );
  label.setAttribute(
    "aria-label",
    request.action ? `Pending ${name} action` : "Website guidance",
  );
  const tail = element("span", "tail");
  tail.setAttribute("aria-hidden", "true");
  const mark = element("span", "mark", tone === "success" ? "✓" : initial);
  mark.setAttribute("aria-hidden", "true");
  const words = element("div", "words");
  words.append(element("p", "title", request.text));
  if (request.detail) words.append(element("p", "detail", request.detail));
  const row = element("div", "row");
  row.append(mark, words);
  label.append(tail, row);
  // Personal values stay as text in this closed tree. A tap returns only the
  // host's answer ID to the extension; the page sees a click on the host node.
  let answered = false,
    unobscured = false;
  const choose = (id) => (event) => {
    if (
      !event.isTrusted ||
      !unobscured ||
      answered ||
      state.paused ||
      state.disposed ||
      dirty ||
      state.dismissed ||
      !state.visible ||
      !label.classList.contains("shown") ||
      Date.now() - visibleSince < 800 ||
      Date.now() >= request.expiresAt
    )
      return;
    // At most once: the extension consumes the offer whether or not the host
    // receives it, and the host replaces this label with its next guide.
    answered = true;
    label.classList.add("answered");
    void chrome.runtime
      .sendMessage({
        type: "task-guide-answer",
        guideId: request.id,
        answerKey: request.answerKey,
        answerId: id,
      })
      .catch(() => {});
  };
  const cards = answers.filter((answer) => answer.kind === "card");
  const buttons = answers.filter((answer) => answer.kind !== "card");
  if (cards.length) {
    const list = element("div", "cards");
    for (const answer of cards) {
      const card = element("button", "card");
      card.type = "button";
      card.append(element("span", "value", answer.text));
      if (answer.tag) card.append(element("span", "purpose", answer.tag));
      card.onclick = choose(answer.id);
      list.append(card);
    }
    label.append(list);
  }
  if (buttons.length) {
    const list = element("div", "actions");
    for (const answer of buttons) {
      const button = element("button", answer.kind, answer.text);
      button.type = "button";
      button.onclick = choose(answer.id);
      list.append(button);
    }
    label.append(list);
  }
  // An offer's secondary answer is its decline; other labels keep Dismiss.
  const close = element(
    "button",
    "close",
    request.action ? "Cancel this action" : "Dismiss guidance",
  );
  close.type = "button";
  if (request.action || !buttons.some((answer) => answer.kind === "secondary"))
    label.append(close);
  root.append(ring, label, pointer, tap);
  shadow.append(style, root);
  pointer.style.display = "none";
  tap.hidden = true;
  ring.hidden = true;
  label.hidden = true;
  monitor.ownedHosts.add(host);
  document.documentElement.append(host);
  // Taps count only while Chromium reports the label as fully visible: not
  // covered by page content (including the top layer), transformed or faded.
  const visibility = new IntersectionObserver(
    (entries) => {
      unobscured = entries.at(-1).isVisible === true;
    },
    { trackVisibility: true, delay: 100 },
  );
  visibility.observe(label);
  let frame,
    face = "",
    disposed = false,
    dirty = false,
    lastGeometry = "",
    stable = 0,
    visibleSince = 0,
    appearedAt = 0,
    acted = false,
    travel = instant ? "done" : "idle",
    travelAt = 0;
  const place = (point) => {
    pointer.style.left = `${point[0] - 3}px`;
    pointer.style.top = `${point[1] - 2}px`;
  };
  const hide = () => {
    ring.hidden = true;
    label.hidden = true;
    if (!instant) label.classList.remove("shown");
    tap.hidden = true;
    visibleSince = 0;
    appearedAt = 0;
    if (!state.paused) {
      pointer.style.display = "none";
      pointer.classList.remove("tapping");
      if (travel !== "done") travel = "idle";
    }
  };
  const moving = () => {
    hide();
    stable = 0;
  };
  const invalidate = () => {
    dirty = true;
    state.invalidated = true;
    hide();
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) => record.target !== host && !host.contains(record.target),
      )
    )
      invalidate();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const viewport = window.visualViewport;
  window.addEventListener("scroll", moving, true);
  window.addEventListener("resize", moving);
  viewport?.addEventListener("resize", moving);
  viewport?.addEventListener("scroll", moving);
  window.addEventListener("pagehide", invalidate);
  document.addEventListener("beforeinput", invalidate, true);
  document.addEventListener("change", invalidate, true);
  const state = {
    id: request.id,
    nodeId: request.nodeId,
    dismissed,
    host,
    shadow,
    visible: false,
    appeared: false,
    paused: false,
    disposed: false,
    actionReady: (id, snapshotId, nodeId, action) =>
      Boolean(
        request.action &&
          !acted &&
          !disposed &&
          !dirty &&
          !state.paused &&
          !state.dismissed &&
          state.visible &&
          visibleSince &&
          Date.now() - visibleSince >= 800 &&
          Date.now() < request.expiresAt &&
          request.id === id &&
          request.snapshotId === snapshotId &&
          request.nodeId === nodeId &&
          request.action === action,
      ),
    markActed: () => {
      acted = true;
      tap.hidden = false;
    },
    pause: () => {
      const shown =
        pointer.style.display !== "none" && pointer.getBoundingClientRect();
      const point = shown ? [shown.left + 3, shown.top + 2] : cursor.point;
      state.paused = true;
      state.visible = false;
      hide();
      if (!point) return;
      cursor.point = point;
      pointer.classList.remove("tapping");
      pointer.classList.add("paused");
      place(point);
      nameTag.textContent = `${name} · paused`;
      pointer.style.display = "block";
    },
    destroy: () => {
      disposed = true;
      state.disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      window.removeEventListener("scroll", moving, true);
      window.removeEventListener("resize", moving);
      viewport?.removeEventListener("resize", moving);
      viewport?.removeEventListener("scroll", moving);
      window.removeEventListener("pagehide", invalidate);
      document.removeEventListener("beforeinput", invalidate, true);
      document.removeEventListener("change", invalidate, true);
      host.remove();
      state.visible = false;
    },
  };
  close.onclick = () => {
    state.dismissed = true;
    state.visible = false;
    hide();
  };
  globalThis[key] = state;
  const update = () => {
    if (disposed) return;
    state.visible = false;
    const family = fontFamily();
    if (family !== face) {
      face = family;
      root.style.setProperty("--face", face);
    }
    if (acted || state.paused) {
      if (acted) {
        label.hidden = true;
        pointer.style.display = "none";
        tap.hidden = false;
      }
      if (
        Date.now() >= request.expiresAt ||
        location.href !== snapshot.url ||
        !host.isConnected
      ) {
        state.destroy();
        return;
      }
      frame = requestAnimationFrame(update);
      return;
    }
    if (
      Date.now() >= request.expiresAt ||
      location.href !== snapshot.url ||
      !host.isConnected ||
      !target.isConnected
    ) {
      state.destroy();
      return;
    }
    if (dirty || state.dismissed) {
      hide();
      frame = requestAnimationFrame(update);
      return;
    }
    const rect = target.getBoundingClientRect();
    const view = {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? innerWidth,
      height: viewport?.height ?? innerHeight,
      scale: viewport?.scale ?? 1,
    };
    const geometry = JSON.stringify([
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      view,
    ]);
    if (geometry !== lastGeometry) {
      lastGeometry = geometry;
      stable = 0;
      hide();
    } else stable++;
    const css = getComputedStyle(target);
    if (
      stable >= 2 &&
      rect.width > 0 &&
      rect.height > 0 &&
      css.visibility === "visible" &&
      css.display !== "none" &&
      rect.left >= view.left &&
      rect.top >= view.top &&
      rect.right <= view.left + view.width &&
      rect.bottom <= view.top + view.height
    ) {
      label.hidden = false;
      label.style.width = `${Math.min(answers.length ? 440 : 360, view.width - 24)}px`;
      const height = label.getBoundingClientRect().height,
        width = label.getBoundingClientRect().width;
      const candidates = [
        { x: rect.left, y: rect.bottom + 22, tail: "" },
        { x: rect.left, y: rect.top - height - 22, tail: "up" },
        { x: rect.right + 22, y: rect.top },
        { x: rect.left - width - 22, y: rect.top },
      ];
      const position = candidates
        .map((p) => ({
          ...p,
          x: Math.max(
            view.left + 8,
            Math.min(p.x, view.left + view.width - width - 8),
          ),
          y: Math.max(
            view.top + 8,
            Math.min(p.y, view.top + view.height - height - 8),
          ),
        }))
        .find(
          (p) =>
            p.y >= view.top + 8 &&
            p.y + height <= view.top + view.height - 8 &&
            (p.x + width <= rect.left - 8 ||
              p.x >= rect.right + 8 ||
              p.y + height <= rect.top - 8 ||
              p.y >= rect.bottom + 8),
        );
      if (position) {
        label.style.left = `${position.x}px`;
        label.style.top = `${position.y}px`;
        tail.hidden = position.tail === undefined;
        tail.className = position.tail ? "tail up" : "tail";
        tail.style.left = `${Math.max(14, Math.min(rect.left + 28 - position.x, width - 32))}px`;
        Object.assign(ring.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          borderRadius: css.borderRadius,
        });
        const point = [
          rect.left + Math.min(rect.width / 2, 120),
          rect.top + rect.height / 2,
        ];
        const now = Date.now();
        // Travel from where the cursor was last seen, tap the air (show-only),
        // then hide. An action pointer stays on its target instead.
        if (travel === "idle") {
          pointer.style.transition = "none";
          place(
            cursor.point ?? [
              view.left + view.width * 0.78,
              view.top + view.height * 0.67,
            ],
          );
          pointer.style.display = "block";
          pointer.getBoundingClientRect();
          pointer.style.transition = "";
          place(point);
          cursor.point = point;
          travel = "moving";
          travelAt = now;
        } else if (travel === "moving" && now - travelAt >= 1400) {
          if (request.action) travel = "done";
          else {
            travel = "tapping";
            travelAt = now;
            pointer.classList.add("tapping");
          }
        } else if (travel === "tapping" && now - travelAt >= 700) {
          travel = "done";
          pointer.classList.remove("tapping");
          pointer.style.display = "none";
        }
        if (travel !== "done") {
          label.hidden = true;
          frame = requestAnimationFrame(update);
          return;
        }
        ring.hidden = Boolean(request.action);
        cursor.point = point;
        if (!appearedAt) appearedAt = now;
        if (now - appearedAt >= 250) label.classList.add("shown");
        if (request.action) {
          pointer.style.transition = "none";
          place(point);
          pointer.style.display = "block";
          tap.style.left = `${point[0] - 18}px`;
          tap.style.top = `${point[1] - 18}px`;
          tap.hidden = !acted;
        }
        state.visible = true;
        state.appeared = true;
        if (!visibleSince) visibleSince = now;
      } else hide();
    } else hide();
    frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);
  return { accepted: true, visible: false, dismissed: state.dismissed };
}
