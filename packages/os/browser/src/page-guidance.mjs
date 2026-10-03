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
        previous.invalidated,
    };
  if (request.kind === "hide") {
    previous?.destroy();
    return { visible: false };
  }
  const fail = (reason) => {
    previous?.destroy();
    return { visible: false, reason };
  };
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
  previous?.destroy();
  const host = document.createElement("div");
  host.style.cssText =
    "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ":host{font:20px/1.4 system-ui;color:#17191c}.ring{position:fixed;box-sizing:border-box;border:4px solid #245be8;border-radius:8px;pointer-events:none}.label{font:20px/1.4 system-ui;position:fixed;box-sizing:border-box;background:#fff;color:#17191c;border:2px solid #245be8;border-radius:12px;padding:12px;box-shadow:0 4px 18px #0003;pointer-events:auto;max-width:360px}p{margin:0 0 8px}button{font:inherit;min-height:44px;background:#fff;color:#17191c;border:2px solid #17191c;border-radius:8px;padding:6px 12px}button:focus-visible{outline:3px solid #245be8;outline-offset:2px}[hidden]{display:none!important}";
  style.textContent +=
    ".pointer{position:fixed;width:38px;height:48px;pointer-events:none;filter:drop-shadow(0 2px 2px #0006)}.tap{position:fixed;width:34px;height:34px;border:4px solid #c54e00;border-radius:50%;box-sizing:border-box;pointer-events:none}.action-label{border-color:#c54e00}";
  const pointer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  pointer.setAttribute("viewBox", "0 0 38 48");
  pointer.setAttribute("class", "pointer");
  pointer.setAttribute("aria-hidden", "true");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M3 3 L3 35 L12 27 L20 44 L29 40 L21 23 L34 23 Z");
  arrow.setAttribute("fill", "#c54e00");
  arrow.setAttribute("stroke", "#fff");
  arrow.setAttribute("stroke-width", "3");
  pointer.append(arrow);
  const tap = document.createElement("div");
  tap.className = "tap";
  tap.setAttribute("aria-hidden", "true");
  const ring = document.createElement("div");
  ring.className = "ring";
  ring.setAttribute("aria-hidden", "true");
  const label = document.createElement("section");
  label.className = request.action ? "label action-label" : "label";
  label.setAttribute(
    "aria-label",
    request.action ? "Pending Eliza action" : "Website guidance",
  );
  const text = document.createElement("p");
  text.textContent = request.text;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = request.action
    ? "Cancel this action"
    : "Dismiss guidance";
  label.append(text, close);
  shadow.append(style, ring, label, pointer, tap);
  pointer.style.display = "none";
  tap.hidden = true;
  ring.hidden = true;
  label.hidden = true;
  monitor.ownedHosts.add(host);
  document.documentElement.append(host);
  let frame,
    disposed = false,
    dirty = false,
    lastGeometry = "",
    stable = 0,
    visibleSince = 0,
    acted = false;
  const hide = () => {
    ring.hidden = true;
    label.hidden = true;
    pointer.style.display = "none";
    tap.hidden = true;
    visibleSince = 0;
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
    dismissed,
    host,
    shadow,
    visible: false,
    disposed: false,
    actionReady: (id, snapshotId, nodeId, action) =>
      Boolean(
        request.action &&
          !acted &&
          !disposed &&
          !dirty &&
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
    destroy: () => {
      disposed = true;
      state.disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
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
    if (acted) {
      label.hidden = true;
      pointer.style.display = "none";
      tap.hidden = false;
      if (Date.now() >= request.expiresAt || !host.isConnected) {
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
      label.style.width = `${Math.min(360, view.width - 24)}px`;
      const height = label.getBoundingClientRect().height,
        width = label.getBoundingClientRect().width;
      const candidates = [
        { x: rect.left, y: rect.bottom + 12 },
        { x: rect.left, y: rect.top - height - 12 },
        { x: rect.right + 12, y: rect.top },
        { x: rect.left - width - 12, y: rect.top },
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
        Object.assign(ring.style, {
          left: `${rect.left - 4}px`,
          top: `${rect.top - 4}px`,
          width: `${rect.width + 8}px`,
          height: `${rect.height + 8}px`,
        });
        ring.hidden = Boolean(request.action);
        if (request.action) {
          pointer.style.display = "block";
          pointer.style.left = `${rect.left + rect.width / 2 - 3}px`;
          pointer.style.top = `${rect.top + rect.height / 2 - 3}px`;
          tap.style.left = `${rect.left + rect.width / 2 - 17}px`;
          tap.style.top = `${rect.top + rect.height / 2 - 17}px`;
          tap.hidden = !acted;
        }
        state.visible = true;
        if (!visibleSince) visibleSince = Date.now();
      } else hide();
    } else hide();
    frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);
  return { accepted: true, visible: false, dismissed: state.dismissed };
}
