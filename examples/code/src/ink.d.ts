// Type declaration to fix ink/React 19 compatibility issues
// See: https://github.com/vadimdemedes/ink/issues/666
import type { FC, ReactNode } from "react";

declare module "ink-text-input" {
  export interface TextInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    focus?: boolean;
    mask?: string;
    showCursor?: boolean;
    highlightPastedText?: boolean;
  }

  const TextInput: FC<TextInputProps>;
  export default TextInput;
}

declare module "ink" {
  export interface BoxProps {
    children?: ReactNode;
    flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number | string;
    flexWrap?: "nowrap" | "wrap" | "wrap-reverse";
    alignItems?: "flex-start" | "flex-end" | "center" | "stretch";
    alignSelf?: "auto" | "flex-start" | "flex-end" | "center" | "stretch";
    justifyContent?:
      | "flex-start"
      | "flex-end"
      | "center"
      | "space-between"
      | "space-around"
      | "space-evenly";
    width?: number | string;
    height?: number | string;
    minWidth?: number | string;
    minHeight?: number | string;
    maxWidth?: number | string;
    maxHeight?: number | string;
    margin?: number;
    marginX?: number;
    marginY?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    padding?: number;
    paddingX?: number;
    paddingY?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    gap?: number;
    columnGap?: number;
    rowGap?: number;
    borderStyle?:
      | "single"
      | "double"
      | "round"
      | "bold"
      | "singleDouble"
      | "doubleSingle"
      | "classic"
      | "arrow";
    borderColor?: string;
    borderTop?: boolean;
    borderBottom?: boolean;
    borderLeft?: boolean;
    borderRight?: boolean;
    borderDimColor?: boolean;
    display?: "flex" | "none";
    overflow?: "visible" | "hidden";
    overflowX?: "visible" | "hidden";
    overflowY?: "visible" | "hidden";
    position?: "absolute" | "relative";
  }

  export const Box: FC<BoxProps>;

  export interface TextProps {
    children?: ReactNode;
    color?: string;
    backgroundColor?: string;
    dimColor?: boolean;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    inverse?: boolean;
    wrap?:
      | "wrap"
      | "truncate"
      | "truncate-start"
      | "truncate-middle"
      | "truncate-end";
  }

  export const Text: FC<TextProps>;

  export interface StaticProps<T> {
    items: T[];
    children: (item: T, index: number) => ReactNode;
    style?: BoxProps;
  }

  export function Static<T>(props: StaticProps<T>): ReactNode;

  export function useInput(
    inputHandler: (input: string, key: Key) => void,
    options?: { isActive?: boolean },
  ): void;

  export function useApp(): { exit: (error?: Error) => void };

  export function useStdout(): {
    stdout: NodeJS.WriteStream;
    write: (data: string) => void;
  };

  export function useStdin(): {
    stdin: NodeJS.ReadStream;
    setRawMode: (value: boolean) => void;
    isRawModeSupported: boolean;
  };

  export function useFocus(options?: {
    autoFocus?: boolean;
    isActive?: boolean;
    id?: string;
  }): {
    isFocused: boolean;
  };

  export function useFocusManager(): {
    enableFocus: () => void;
    disableFocus: () => void;
    focusNext: () => void;
    focusPrevious: () => void;
    focus: (id: string) => void;
  };

  export interface Key {
    upArrow: boolean;
    downArrow: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    pageDown: boolean;
    pageUp: boolean;
    return: boolean;
    escape: boolean;
    ctrl: boolean;
    shift: boolean;
    tab: boolean;
    backspace: boolean;
    delete: boolean;
    meta: boolean;
  }

  export interface RenderOptions {
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    stderr?: NodeJS.WriteStream;
    debug?: boolean;
    exitOnCtrlC?: boolean;
    patchConsole?: boolean;
  }

  export interface Instance {
    rerender: (tree: ReactNode) => void;
    unmount: () => void;
    waitUntilExit: () => Promise<void>;
    cleanup: () => void;
    clear: () => void;
  }

  export function render(tree: ReactNode, options?: RenderOptions): Instance;

  export interface MeasureLayoutEvent {
    width: number;
    height: number;
  }

  export function measureElement(ref: {
    current: DOMElement | null;
  }): MeasureLayoutEvent | undefined;

  export interface DOMElement {
    nodeName: string;
    attributes: Record<string, unknown>;
    childNodes: DOMElement[];
    parentNode: DOMElement | null;
    yogaNode?: unknown;
    internal_static?: boolean;
    style: BoxProps;
  }

  export interface Newline {
    count?: number;
  }

  export const Newline: FC<Newline>;

  export interface SpacerProps {
    // Empty props
  }

  export const Spacer: FC<SpacerProps>;

  export interface TransformProps {
    children?: ReactNode;
    transform: (children: string) => string;
  }

  export const Transform: FC<TransformProps>;
}
