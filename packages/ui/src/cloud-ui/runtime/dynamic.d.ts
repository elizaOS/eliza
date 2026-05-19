import { type ComponentType } from "react";
type DynamicModule<P> = ComponentType<P> | {
    default: ComponentType<P>;
};
type DynamicOptions = {
    loading?: ComponentType;
    ssr?: boolean;
};
export default function dynamic<P extends object>(loader: () => Promise<DynamicModule<P>>, options?: DynamicOptions): ComponentType<P>;
export {};
//# sourceMappingURL=dynamic.d.ts.map