import { Fragment, isValidElement } from "react";

const REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element");
const REACT_LEGACY_ELEMENT_TYPE = Symbol.for("react.element");
const REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_PORTAL_TYPE = Symbol.for("react.portal");

export function typeOf(object: unknown): unknown {
  if (!object || typeof object !== "object") return undefined;
  const candidate = object as { $$typeof?: symbol; type?: unknown };
  if (
    candidate.$$typeof !== REACT_ELEMENT_TYPE &&
    candidate.$$typeof !== REACT_LEGACY_ELEMENT_TYPE
  ) {
    return candidate.$$typeof;
  }
  return candidate.type;
}

export function isElement(object: unknown): boolean {
  return isValidElement(object);
}

export function isFragment(object: unknown): boolean {
  return typeOf(object) === Fragment || typeOf(object) === REACT_FRAGMENT_TYPE;
}

export function isForwardRef(object: unknown): boolean {
  return typeOf(object) === REACT_FORWARD_REF_TYPE;
}

export function isMemo(object: unknown): boolean {
  return typeOf(object) === REACT_MEMO_TYPE;
}

export function isPortal(object: unknown): boolean {
  return typeOf(object) === REACT_PORTAL_TYPE;
}

export default {
  isElement,
  isForwardRef,
  isFragment,
  isMemo,
  isPortal,
  typeOf,
};