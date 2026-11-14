type Shape = Record<string, Record<string, string>>;
type Props<V> = { [Name in keyof V]?: keyof V[Name] | null } & { className?: string };
export declare function cva<V extends Shape>(base: string, config: { variants: V; defaultVariants?: { [Name in keyof V]?: keyof V[Name] } }): (props?: Props<V>) => string;
export type VariantProps<Component extends (props?: any) => string> = Omit<NonNullable<Parameters<Component>[0]>, "className">;
