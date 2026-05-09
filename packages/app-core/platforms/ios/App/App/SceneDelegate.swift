import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
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

        var pluginOptions: [String: Any?] = [
            UIApplication.OpenURLOptionsKey.openInPlace.rawValue: context.options.openInPlace
        ]
        if let sourceApplication = context.options.sourceApplication {
            pluginOptions[UIApplication.OpenURLOptionsKey.sourceApplication.rawValue] = sourceApplication
        }
        if let annotation = context.options.annotation {
            pluginOptions[UIApplication.OpenURLOptionsKey.annotation.rawValue] = annotation
        }
        NotificationCenter.default.post(name: .capacitorOpenURL, object: [
            "url": context.url as NSURL,
            "options": pluginOptions
        ])
    }

    private func forwardUserActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
        if let webpageURL = userActivity.webpageURL {
            NotificationCenter.default.post(name: .capacitorOpenUniversalLink, object: [
                "url": webpageURL as NSURL
            ])
        }
    }
}
