// As much of React's types as the fixtures use; the test installs `modules` as the copy's `node_modules`.
export interface ReactElement { type: unknown }
export type ReactNode = ReactElement | string | number | boolean | null | undefined;
interface Attributes { className?: string; children?: ReactNode; translate?: "yes" | "no" }
export interface Elements { span: Attributes; [name: string]: any }
export type ComponentProps<Name extends keyof Elements> = Elements[Name];
