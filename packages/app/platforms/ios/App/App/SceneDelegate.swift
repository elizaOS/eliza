import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        ElizaBrandTint.install(on: window)

        for context in connectionOptions.urlContexts {
            forwardOpenUrl(context)
        }

        for activity in connectionOptions.userActivities {
            forwardUserActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            forwardOpenUrl(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        forwardUserActivity(userActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        ElizaBrandTint.install(on: window)
    }

    private func forwardOpenUrl(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: context.options.openInPlace
        ]

        if let sourceApplication = context.options.sourceApplication {
            options[.sourceApplication] = sourceApplication
        }

        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }

        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: context.url,
            options: options
        )

        // The proxy posts capacitorOpenURL and records the launch URL itself.
    }

    private func forwardUserActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
        // The proxy posts capacitorOpenUniversalLink for browsing activities.
    }
}
