import type { DataPart } from "@json-render/react";
import { useJsonRenderMessage as officialUseJsonRenderMessage } from "@json-render/react";
import { useMemo } from "react";
import type { ElizaGenUiSpec, ElizaGenUiValidationOptions } from "./types";

type MessagePart =
  | { type: "text"; text: string }
  | { type: "data-spec"; data?: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

type UseJsonRenderMessageResult = {
  spec: ElizaGenUiSpec | null;
  hasSpec: boolean;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function toDataParts(
  parts: readonly MessagePart[] | null | undefined,
): DataPart[] {
  if (!parts) return [];
  return Array.from(parts) as DataPart[];
}

export function useJsonRenderMessage(
  parts: readonly MessagePart[] | null | undefined,
  _validationOptions?: ElizaGenUiValidationOptions,
): UseJsonRenderMessageResult {
  const dataParts = useMemo(() => toDataParts(parts), [parts]);

  const officialResult = officialUseJsonRenderMessage(dataParts);

  return useMemo(() => {
    const { spec: officialSpec, text: officialText, hasSpec } = officialResult;

    if (!hasSpec || !officialSpec) {
      return { spec: null, hasSpec: false, text: officialText ?? "" };
    }

    const { root, elements, state } = officialSpec;
    const components = Object.entries(elements).map(([id, el]) => {
      const record = toRecord(el);
      const type = typeof record.type === "string" ? record.type : undefined;
      const props = toRecord(record.props);
      const children = toStringArray(record.children);
      return {
        id,
        component: type ?? "unknown",
        ...(children ? { children } : {}),
        ...(props ? (props as Record<string, unknown>) : {}),
      };
    }) as ElizaGenUiSpec["components"];

    const spec: ElizaGenUiSpec = {
      version: "0.1",
      root: root ?? "",
      components,
      data: state as Record<string, unknown> | undefined,
    } as ElizaGenUiSpec;

    return { spec, hasSpec: true, text: officialText ?? "" };
  }, [officialResult]);
}

export { officialUseJsonRenderMessage as useOfficialJsonRenderMessage };
