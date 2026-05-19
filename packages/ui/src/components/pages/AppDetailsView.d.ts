/**
 * AppDetailsView — config + diagnostics + widgets + Launch button page
 * for apps that need it (those with `hasDetailsPage: true` in their
 * descriptor, or any registry/catalog app with launch params).
 *
 * Mounted by AppsView when the apps sub-path is `/apps/<slug>/details`.
 */
import { type RegistryAppInfo } from "../../api";
import { type AppLaunchMode } from "../apps/per-app-config";
interface AppDetailsViewProps {
    slug: string;
    /**
     * Called when the user successfully launches the app. The parent
     * (AppsView) navigates the apps sub-path back to "browse" or to the
     * inline run route depending on launch mode.
     */
    onLaunched?: (info: {
        mode: AppLaunchMode;
        slug: string;
    }) => void;
}
export declare function AppDetailsView({ slug, onLaunched, }: AppDetailsViewProps): React.JSX.Element;
/**
 * Convenience: does this slug resolve to an app that wants the details
 * page? Used by AppsView.handleLaunch to decide whether to navigate to
 * /apps/<slug>/details or call openAppRouteWindow directly.
 *
 * Internal tools opt in with `hasDetailsPage`; catalog apps opt in through
 * launch metadata that implies setup, runtime control, or a heavier session.
 */
export declare function appNeedsDetailsPage(app: RegistryAppInfo | string): boolean;
export {};
//# sourceMappingURL=AppDetailsView.d.ts.map