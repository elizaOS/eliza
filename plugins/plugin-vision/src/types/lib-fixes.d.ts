/// <reference no-default-lib="true"/>
/// <reference lib="es2022" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="webworker" />

// Type aliases for WebGL array types
type _Float32List = Float32Array | ArrayLike<number>;
type _Int32List = Int32Array | ArrayLike<number>;
type _Uint32List = Uint32Array | ArrayLike<number>;

// Fix pg-protocol
declare module "pg-protocol/dist/messages" {
  export interface NoticeMessage {
    length: number;
    name: string;
    severity: string;
    code: string;
    message: string;
    detail?: string;
    hint?: string;
    position?: string;
    internalPosition?: string;
    internalQuery?: string;
    where?: string;
    schema?: string;
    table?: string;
    column?: string;
    dataType?: string;
    constraint?: string;
    file?: string;
    line?: string;
    routine?: string;
  }
}

// React types for React Router
declare module "react" {
  export type FC<P = object> = (props: P) => ReactElement | null;

  export type ComponentType<P = object> = (props: P) => ReactElement | null;

  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: unknown;
  }

  export type ReactNode = ReactElement | string | number | boolean | null | undefined;
}

// Fix React Router types
declare module "react-router" {
  // biome-ignore lint/complexity/noBannedTypes: React Router generic defaults require empty object type
  export interface match<Params = {}> {
    params: Params;
    isExact: boolean;
    path: string;
    url: string;
  }

  export interface RouteComponentProps<Params = object> {
    match: match<Params>;
    location: Location;
    history: History;
  }

  export interface SwitchProps {
    children?: ReactNode;
    location?: Location;
  }

  export interface PromptProps {
    message: string | ((location: Location) => string | boolean);
    when?: boolean;
  }

  export interface RedirectProps {
    to: string | Location;
    push?: boolean;
    from?: string;
    path?: string;
    exact?: boolean;
    strict?: boolean;
  }

  export interface RouteChildrenProps<Params = object> {
    match: match<Params> | null;
    location: Location;
    history: History;
  }

  export const Prompt: React.ComponentType<PromptProps>;
  export const Switch: React.ComponentType<SwitchProps>;
  export const Redirect: React.ComponentType<RedirectProps>;
  export const Route: React.ComponentType<unknown>;
  export const Router: React.ComponentType<unknown>;
  export const withRouter: <P extends RouteComponentProps>(
    component: React.ComponentType<P>
  ) => React.ComponentType<Omit<P, keyof RouteComponentProps>>;
  export const useHistory: () => History;
  export const useLocation: () => Location;
  // biome-ignore lint/complexity/noBannedTypes: React Router generic defaults require empty object type
  export const useParams: <Params = {}>() => Params;
  // biome-ignore lint/complexity/noBannedTypes: React Router generic defaults require empty object type
  export const useRouteMatch: <Params = {}>() => match<Params>;

  export interface Location {
    pathname: string;
    search: string;
    hash: string;
    state?: unknown;
  }

  export interface History {
    length: number;
    action: string;
    location: Location;
    push(path: string, state?: unknown): void;
    push(location: Location): void;
    replace(path: string, state?: unknown): void;
    replace(location: Location): void;
    go(n: number): void;
    goBack(): void;
    goForward(): void;
    block(prompt?: string | ((location: Location, action: string) => string | boolean)): () => void;
    listen(listener: (location: Location, action: string) => void): () => void;
  }

  export const RouterChildContext: React.Context<unknown>;
}

// Fix MDX types
declare module "mdx" {
  export type MDXComponents = {
    [key: string]: React.ComponentType<unknown>;
  };
}

export {};
