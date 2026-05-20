import * as React from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { cn } from "../lib/utils";
import { routeElizaGenUiAction } from "./actions";
import {
  ELIZA_GENUI_DOMAIN_COMPONENTS,
  isElizaGenUiPrimitiveComponent,
} from "./catalog";
import type {
  ElizaGenUiAction,
  ElizaGenUiComponent,
  ElizaGenUiJsonValue,
  ElizaGenUiRenderContext,
  ElizaGenUiRendererProps,
} from "./types";
import { validateElizaGenUiSpec } from "./validator";

type ButtonVariant = React.ComponentProps<typeof Button>["variant"];

function stringProp(
  component: ElizaGenUiComponent,
  key: string,
): string | undefined {
  const value = component[key];
  return typeof value === "string" ? value : undefined;
}

function numberProp(
  component: ElizaGenUiComponent,
  key: string,
): number | undefined {
  const value = component[key];
  return typeof value === "number" ? value : undefined;
}

function booleanProp(
  component: ElizaGenUiComponent,
  key: string,
): boolean | undefined {
  const value = component[key];
  return typeof value === "boolean" ? value : undefined;
}

function textContent(component: ElizaGenUiComponent): string {
  const text = stringProp(component, "text");
  if (text !== undefined) {
    return text;
  }
  const value = component.value;
  return typeof value === "string" ? value : "";
}

function renderChildList(
  component: ElizaGenUiComponent,
  context: ElizaGenUiRenderContext,
  stack: readonly string[],
): React.ReactNode[] {
  const refs = Array.isArray(component.children)
    ? component.children
    : component.child
      ? [component.child]
      : [];
  return refs.map((id) => (
    <React.Fragment key={id}>
      {context.renderComponent(id, [...stack, component.id])}
    </React.Fragment>
  ));
}

function buttonVariant(value: string | undefined): ButtonVariant {
  if (
    value === "secondary" ||
    value === "outline" ||
    value === "ghost" ||
    value === "link" ||
    value === "destructive" ||
    value === "surface" ||
    value === "surfaceAccent" ||
    value === "surfaceDestructive"
  ) {
    return value;
  }
  return "default";
}

function toAction(value: unknown): ElizaGenUiAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const action = value as ElizaGenUiAction;
  return action.event && typeof action.event.name === "string" ? action : null;
}

function handleAction(
  action: ElizaGenUiAction | null,
  component: ElizaGenUiComponent,
  context: ElizaGenUiRenderContext,
): void {
  if (!action) {
    return;
  }
  void routeElizaGenUiAction(
    action,
    {
      ...context.context,
      spec: context.spec,
      componentId: component.id,
    },
    context.actionHandlers,
  ).catch((error: Error) => {
    context.onActionError?.(error, action);
  });
}

function renderText(component: ElizaGenUiComponent): React.ReactNode {
  const text = textContent(component);
  switch (stringProp(component, "variant")) {
    case "h1":
      return <h1 className="text-2xl font-semibold">{text}</h1>;
    case "h2":
      return <h2 className="text-xl font-semibold">{text}</h2>;
    case "h3":
      return <h3 className="text-lg font-semibold">{text}</h3>;
    case "code":
      return <code className="rounded bg-muted px-1 py-0.5">{text}</code>;
    default:
      return <span>{text}</span>;
  }
}

function renderChoicePicker(component: ElizaGenUiComponent): React.ReactNode {
  const rawOptions = component.options;
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  return (
    <select
      aria-label={stringProp(component, "label") ?? component.id}
      className="rounded-sm border border-border bg-bg px-3 py-2"
      disabled={booleanProp(component, "disabled")}
      value={stringProp(component, "value")}
      onChange={() => {}}
    >
      {options.map((option) => {
        const record =
          option && typeof option === "object" && !Array.isArray(option)
            ? (option as Record<string, ElizaGenUiJsonValue>)
            : null;
        const label = typeof record?.label === "string" ? record.label : "";
        const value = typeof record?.value === "string" ? record.value : label;
        return (
          <option key={value || label || JSON.stringify(option)} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

function renderTabs(
  component: ElizaGenUiComponent,
  context: ElizaGenUiRenderContext,
  stack: readonly string[],
): React.ReactNode {
  const rawItems = component.tabItems;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return (
    <div className="flex flex-col gap-3" data-eliza-genui-tabs={component.id}>
      <div className="flex flex-wrap gap-2" role="tablist">
        {items.map((item) => {
          const record =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, ElizaGenUiJsonValue>)
              : null;
          const title = typeof record?.title === "string" ? record.title : "";
          const child = typeof record?.child === "string" ? record.child : "";
          return (
            <button
              key={child || title || JSON.stringify(item)}
              type="button"
              className="rounded-sm border border-border px-3 py-1 text-sm"
              role="tab"
            >
              {title}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const record =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, ElizaGenUiJsonValue>)
              : null;
          const child = typeof record?.child === "string" ? record.child : "";
          return (
            <div key={child || JSON.stringify(item)} role="tabpanel">
              {context.renderComponent(child, [...stack, component.id])}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderPrimitiveComponent(
  component: ElizaGenUiComponent,
  context: ElizaGenUiRenderContext,
  stack: readonly string[],
): React.ReactNode {
  switch (component.component) {
    case "Row":
      return (
        <div className="flex flex-wrap items-center gap-2">
          {renderChildList(component, context, stack)}
        </div>
      );
    case "Column":
      return (
        <div className="flex flex-col gap-3">
          {renderChildList(component, context, stack)}
        </div>
      );
    case "List":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {React.Children.toArray(
            renderChildList(component, context, stack),
          ).map((child) => (
            <li key={React.isValidElement(child) ? child.key : String(child)}>
              {child}
            </li>
          ))}
        </ul>
      );
    case "Text":
      return renderText(component);
    case "Image":
      return (
        <img
          alt={stringProp(component, "alt") ?? ""}
          className="max-w-full rounded-sm"
          src={stringProp(component, "src")}
        />
      );
    case "Icon":
      return (
        <span
          aria-hidden="true"
          data-eliza-genui-icon={stringProp(component, "name")}
        >
          {stringProp(component, "name") ?? ""}
        </span>
      );
    case "Divider":
      return <hr className="border-border" />;
    case "Button": {
      const action = toAction(component.action);
      return (
        <Button
          disabled={booleanProp(component, "disabled")}
          type="button"
          variant={buttonVariant(stringProp(component, "variant"))}
          onClick={() => handleAction(action, component, context)}
        >
          {renderChildList(component, context, stack)}
          {!component.child && !component.children
            ? textContent(component)
            : null}
        </Button>
      );
    }
    case "TextField":
      return (
        <input
          aria-label={stringProp(component, "label") ?? component.id}
          className="rounded-sm border border-border bg-bg px-3 py-2"
          disabled={booleanProp(component, "disabled")}
          placeholder={stringProp(component, "placeholder")}
          readOnly
          type="text"
          value={stringProp(component, "value") ?? ""}
        />
      );
    case "CheckBox":
      return (
        <input
          aria-label={stringProp(component, "label") ?? component.id}
          checked={booleanProp(component, "checked") ?? false}
          disabled={booleanProp(component, "disabled")}
          readOnly
          type="checkbox"
        />
      );
    case "Slider":
      return (
        <input
          aria-label={stringProp(component, "label") ?? component.id}
          disabled={booleanProp(component, "disabled")}
          max={numberProp(component, "maxValue")}
          min={numberProp(component, "minValue")}
          readOnly
          type="range"
          value={numberProp(component, "value") ?? 0}
        />
      );
    case "DateTimeInput":
      return (
        <input
          aria-label={stringProp(component, "label") ?? component.id}
          disabled={booleanProp(component, "disabled")}
          readOnly
          type="datetime-local"
          value={stringProp(component, "value") ?? ""}
        />
      );
    case "ChoicePicker":
      return renderChoicePicker(component);
    case "Card":
      return (
        <Card className="rounded-sm">
          <CardContent className="p-4">
            {renderChildList(component, context, stack)}
          </CardContent>
        </Card>
      );
    case "Modal":
      return (
        <div className="flex flex-col gap-3">
          {context.renderComponent(stringProp(component, "entryPointChild"), [
            ...stack,
            component.id,
          ])}
          <div role="dialog">
            {context.renderComponent(stringProp(component, "contentChild"), [
              ...stack,
              component.id,
            ])}
          </div>
        </div>
      );
    case "Tabs":
      return renderTabs(component, context, stack);
    default:
      return null;
  }
}

function renderDomainComponent(
  component: ElizaGenUiComponent,
  context: ElizaGenUiRenderContext,
  stack: readonly string[],
): React.ReactNode {
  return (
    <section
      className="rounded-sm border border-border bg-card p-3"
      data-eliza-genui-component={component.component}
    >
      <div className="text-sm font-medium">
        {stringProp(component, "title") ?? component.component}
      </div>
      {renderChildList(component, context, stack)}
    </section>
  );
}

export function ElizaGenUiRenderer({
  spec,
  actionHandlers = [],
  context = {},
  devMode = false,
  className,
  onActionError,
}: ElizaGenUiRendererProps): React.ReactElement | null {
  const validation = validateElizaGenUiSpec(spec);
  if (!validation.ok) {
    if (!devMode) {
      return null;
    }
    return (
      <div className="rounded-sm border border-destructive/40 p-3 text-sm">
        {validation.errors.map((error) => (
          <div key={`${error.code}-${error.path ?? ""}-${error.message}`}>
            {error.message}
          </div>
        ))}
      </div>
    );
  }
  const componentsById = new Map(
    validation.spec.components.map((component) => [component.id, component]),
  );
  const renderContext: ElizaGenUiRenderContext = {
    spec: validation.spec,
    componentsById,
    actionHandlers,
    context,
    onActionError,
    renderComponent(componentId, stack = []) {
      if (!componentId || stack.includes(componentId)) {
        return null;
      }
      const component = componentsById.get(componentId);
      if (!component) {
        return null;
      }
      if (isElizaGenUiPrimitiveComponent(component.component)) {
        return renderPrimitiveComponent(component, renderContext, stack);
      }
      if (
        (ELIZA_GENUI_DOMAIN_COMPONENTS as readonly string[]).includes(
          component.component,
        )
      ) {
        return renderDomainComponent(component, renderContext, stack);
      }
      return null;
    },
  };
  return (
    <div className={cn("eliza-genui", className)}>
      {renderContext.renderComponent(validation.spec.root)}
    </div>
  );
}
