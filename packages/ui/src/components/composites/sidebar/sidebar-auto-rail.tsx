import * as React from "react";

import { SegmentedControl } from "../../ui/segmented-control";
import {
  SidebarItem,
  SidebarItemButton,
  SidebarItemIcon,
  SidebarItemTitle,
  type SidebarRailItemProps,
} from "./sidebar-content";

export interface SidebarAutoRailItem {
  key: string;
  label: string;
  active: boolean;
  disabled: boolean;
  contentKind: "icon" | "monogram";
  indicatorTone?: SidebarRailItemProps["indicatorTone"];
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  content: React.ReactNode;
}

type SidebarElementProps = {
  children?: React.ReactNode;
  [key: string]: unknown;
};

type SidebarElement = React.ReactElement<SidebarElementProps>;

const SIDEBAR_AUTO_RAIL_DOM_SELECTOR =
  "[data-segmented-control-button], [data-sidebar-item], [data-sidebar-item-button], button[aria-pressed]";

function isSidebarElement(node: React.ReactNode): node is SidebarElement {
  return React.isValidElement<SidebarElementProps>(node);
}

function extractTextContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node).trim();
  }
  if (Array.isArray(node)) {
    return node
      .map((child) => extractTextContent(child))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (!isSidebarElement(node)) {
    return "";
  }
  return extractTextContent(node.props.children);
}

function extractFirstTextContent(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node).trim();
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const text = extractFirstTextContent(child);
      if (text) return text;
    }
    return "";
  }
  if (!isSidebarElement(node)) {
    return "";
  }
  return extractFirstTextContent(node.props.children);
}

function cleanRailLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .replace(/^open\s+/i, "")
    .replace(/\s+[—–]\s+.*$/, "")
    .replace(/\s+\(click to .*?\)$/i, "")
    .trim();
}

function buildRailMonogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 1).toUpperCase() || "?").slice(0, 2);
}

function resolveRailContent(label: string, icon: React.ReactNode | null) {
  return icon ?? buildRailMonogram(label);
}

function resolveRailContentKind(icon: React.ReactNode | null) {
  return icon ? "icon" : "monogram";
}

function SidebarAutoRailDomGlyph({ glyphElement }: { glyphElement: Element }) {
  const containerRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.replaceChildren();
    container.append(glyphElement.cloneNode(true));
  }, [glyphElement]);

  return (
    <span
      ref={containerRef}
      aria-hidden
      className="inline-flex items-center justify-center [&_[data-sidebar-item-icon]]:h-8 [&_[data-sidebar-item-icon]]:w-8 [&_img]:h-4 [&_img]:w-4 [&_svg]:h-4 [&_svg]:w-4"
    />
  );
}

function extractDomRailLabel(element: HTMLElement): string {
  const itemBody = element.querySelector<HTMLElement>(
    "[data-sidebar-item-body]",
  );
  const itemTitle = itemBody?.querySelector<HTMLElement>(
    "[data-sidebar-item-title]",
  );
  const primaryBodyChild = itemBody?.firstElementChild;

  return cleanRailLabel(
    itemTitle?.textContent ||
      primaryBodyChild?.textContent ||
      element.getAttribute("title") ||
      element.getAttribute("aria-label") ||
      element.textContent ||
      "",
  );
}

function extractDomRailIcon(element: HTMLElement): React.ReactNode | null {
  const iconElement =
    element.querySelector("[data-sidebar-item-icon]") ||
    element.querySelector("svg, img, [role='img']");

  return iconElement ? (
    <SidebarAutoRailDomGlyph glyphElement={iconElement} />
  ) : null;
}

function findSidebarItemParts(node: React.ReactNode) {
  const state: {
    active: boolean;
    icon: React.ReactNode | null;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    title: string;
  } = {
    active: false,
    icon: null,
    title: "",
  };

  const visit = (child: React.ReactNode) => {
    if (child == null || typeof child === "boolean") return;

    if (typeof child === "string" || typeof child === "number") {
      if (!state.title) {
        state.title = cleanRailLabel(String(child));
      }
      return;
    }

    if (!isSidebarElement(child)) return;

    if (child.type === SidebarItemButton) {
      const buttonChild = child as React.ReactElement<
        React.ComponentProps<typeof SidebarItemButton>
      >;
      if (typeof buttonChild.props.onClick === "function" && !state.onClick) {
        state.onClick = buttonChild.props.onClick;
      }
      if (buttonChild.props["aria-current"]) {
        state.active = true;
      }
      visit(buttonChild.props.children);
      return;
    }

    if (child.type === SidebarItemIcon) {
      const iconChild = child as React.ReactElement<
        React.ComponentProps<typeof SidebarItemIcon>
      >;
      state.icon = iconChild.props.children;
      if (iconChild.props.active) {
        state.active = true;
      }
      return;
    }

    if (child.type === SidebarItemTitle) {
      const titleChild = child as React.ReactElement<
        React.ComponentProps<typeof SidebarItemTitle>
      >;
      const title = cleanRailLabel(
        extractTextContent(titleChild.props.children),
      );
      if (title) {
        state.title = title;
      }
      return;
    }

    if (typeof child.type === "string" && !state.title) {
      const text = cleanRailLabel(extractTextContent(child.props.children));
      if (text) {
        state.title = text;
      }
    }

    visit(child.props.children);
  };

  visit(node);
  return state;
}

function parseSidebarItemElement(node: SidebarElement) {
  const parts = findSidebarItemParts(node.props.children);
  const label =
    parts.title ||
    cleanRailLabel(String(node.props["aria-label"] ?? "")) ||
    cleanRailLabel(extractFirstTextContent(node.props.children));
  if (!label) return null;

  return {
    key: String(node.key ?? label),
    label,
    active:
      Boolean(node.props.active) ||
      Boolean(node.props["aria-current"]) ||
      parts.active,
    disabled: Boolean(node.props.disabled),
    contentKind: resolveRailContentKind(parts.icon),
    onClick:
      typeof node.props.onClick === "function"
        ? (node.props.onClick as React.MouseEventHandler<HTMLButtonElement>)
        : parts.onClick,
    content: resolveRailContent(label, parts.icon),
  } satisfies SidebarAutoRailItem;
}

function findFirstNonTextChild(node: React.ReactNode): React.ReactNode | null {
  if (node == null || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findFirstNonTextChild(child);
      if (match != null) return match;
    }
    return null;
  }
  if (!isSidebarElement(node)) return null;
  return node;
}

function parseNativeToggleButton(node: SidebarElement) {
  if (typeof node.props.onClick !== "function") return null;
  if (node.props["aria-pressed"] === undefined) return null;

  const label = cleanRailLabel(
    String(node.props["aria-label"] ?? node.props.title ?? ""),
  );
  if (!label) return null;

  const icon = findFirstNonTextChild(node.props.children);

  return {
    key: String(node.key ?? node.props["data-testid"] ?? label),
    label,
    active: Boolean(node.props["aria-pressed"]),
    disabled: Boolean(node.props.disabled),
    contentKind: resolveRailContentKind(icon),
    onClick: node.props.onClick as React.MouseEventHandler<HTMLButtonElement>,
    content: resolveRailContent(label, icon),
  } satisfies SidebarAutoRailItem;
}

function parseSegmentedControl(
  node: React.ReactElement<React.ComponentProps<typeof SegmentedControl>>,
) {
  return node.props.items.map((item) => {
    const label = cleanRailLabel(
      extractTextContent(item.label) || String(item.value),
    );
    const icon = findFirstNonTextChild(item.label);

    return {
      key: `${String(node.key ?? "segmented")}:${item.value}`,
      label,
      active: item.value === node.props.value,
      disabled: Boolean(item.disabled),
      contentKind: resolveRailContentKind(icon),
      onClick: () => {
        if (!item.disabled) {
          node.props.onValueChange(item.value);
        }
      },
      content: resolveRailContent(label, icon),
    } satisfies SidebarAutoRailItem;
  });
}

export function buildSidebarAutoRailItems(children: React.ReactNode) {
  const items: SidebarAutoRailItem[] = [];

  const visit = (node: React.ReactNode) => {
    React.Children.forEach(node, (child) => {
      if (!isSidebarElement(child)) return;

      if (child.type === SidebarItem) {
        const item = parseSidebarItemElement(child);
        if (item) items.push(item);
        return;
      }

      if (child.type === SidebarItemButton) {
        const item = parseSidebarItemElement(child);
        if (item) items.push(item);
        return;
      }

      if (
        React.isValidElement<React.ComponentProps<typeof SegmentedControl>>(
          child,
        ) &&
        child.type === SegmentedControl
      ) {
        items.push(...parseSegmentedControl(child));
        return;
      }

      if (typeof child.type === "string" && child.type === "button") {
        const item = parseNativeToggleButton(child);
        if (item) items.push(item);
        return;
      }

      visit(child.props.children);
    });
  };

  visit(children);

  return items;
}

export function buildSidebarAutoRailItemsFromDom(container: HTMLElement) {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(SIDEBAR_AUTO_RAIL_DOM_SELECTOR),
  );

  return candidates
    .filter((element) => {
      if (element.closest("[data-sidebar-filter-bar]")) {
        return false;
      }
      return !element.parentElement?.closest(SIDEBAR_AUTO_RAIL_DOM_SELECTOR);
    })
    .map<SidebarAutoRailItem | null>((element, index) => {
      const label = extractDomRailLabel(element);
      if (!label) return null;

      const interactiveElement =
        element.querySelector<HTMLElement>("[data-sidebar-item-button]") ??
        element;
      const disabled =
        interactiveElement.hasAttribute("disabled") ||
        interactiveElement.getAttribute("aria-disabled") === "true";
      const icon = extractDomRailIcon(element);

      return {
        key: `${label}:${index}`,
        label,
        active:
          interactiveElement.getAttribute("aria-current") === "page" ||
          interactiveElement.querySelector("[aria-current='page']") !== null ||
          interactiveElement.getAttribute("aria-pressed") === "true",
        disabled,
        contentKind: resolveRailContentKind(icon),
        onClick: disabled
          ? undefined
          : () => {
              interactiveElement.click();
            },
        content: resolveRailContent(label, icon),
      } satisfies SidebarAutoRailItem;
    })
    .filter((item): item is SidebarAutoRailItem => item !== null);
}
