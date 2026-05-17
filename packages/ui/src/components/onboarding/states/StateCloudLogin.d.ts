export type CloudOAuthProvider = "google" | "discord" | "x" | "email";
export interface StateCloudLoginProps {
    onConnect: (provider: CloudOAuthProvider) => void;
    onBack: () => void;
}
export declare function StateCloudLogin(props: StateCloudLoginProps): React.JSX.Element;
//# sourceMappingURL=StateCloudLogin.d.ts.map