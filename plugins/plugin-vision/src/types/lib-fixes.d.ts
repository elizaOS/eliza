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
declare module 'pg-protocol/dist/messages' {
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
declare module 'react' {
  export interface FC<P = {}> {
    (props: P): ReactElement | null;
  }

  export interface ComponentType<P = {}> {
    (props: P): ReactElement | null;
  }

  export interface ReactElement {
    type: any;
    props: any;
    key: any;
  }

  export type ReactNode = ReactElement | string | number | boolean | null | undefined;
}

// Fix React Router types
declare module 'react-router' {
  export interface match<Params = {}> {
    params: Params;
    isExact: boolean;
    path: string;
    url: string;
  }

  export interface RouteComponentProps<Params = {}> {
    match: match<Params>;
    location: Location;
    history: History;
  }

  export interface SwitchProps {
    children?: any;
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

  export interface RouteChildrenProps<Params = {}> {
    match: match<Params> | null;
    location: Location;
    history: History;
  }

  export const Prompt: any;
  export const Switch: any;
  export const Redirect: any;
  export const Route: any;
  export const Router: any;
  export const withRouter: <_P extends RouteComponentProps>(component: any) => any;
  export const useHistory: () => History;
  export const useLocation: () => Location;
  export const useParams: <Params = {}>() => Params;
  export const useRouteMatch: <Params = {}>() => match<Params>;

  export interface Location {
    pathname: string;
    search: string;
    hash: string;
    state?: any;
  }

  export interface History {
    length: number;
    action: string;
    location: Location;
    push(path: string, state?: any): void;
    push(location: Location): void;
    replace(path: string, state?: any): void;
    replace(location: Location): void;
    go(n: number): void;
    goBack(): void;
    goForward(): void;
    block(prompt?: string | ((location: Location, action: string) => string | boolean)): () => void;
    listen(listener: (location: Location, action: string) => void): () => void;
  }

  export const RouterChildContext: any;
}

// Fix MDX types
declare module 'mdx' {
  export type MDXComponents = {
    [key: string]: any;
  };
}

export {};
