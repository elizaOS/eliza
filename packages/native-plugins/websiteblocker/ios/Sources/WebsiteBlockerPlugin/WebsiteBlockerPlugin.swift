import Foundation
import Capacitor
import UIKit

@objc(ElizaWebsiteBlockerPlugin)
public class ElizaWebsiteBlockerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaWebsiteBlockerPlugin"
    public let jsName = "ElizaWebsiteBlocker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    @objc func getStatus(_ call: CAPPluginCall) {
        Task {
            call.resolve(await buildStatus())
        }
    }

    @objc func startBlock(_ call: CAPPluginCall) {
        Task {
            let websites = WebsiteBlockerShared.parseWebsites(
                explicit: call.getArray("websites") ?? [],
                text: call.getString("text")
            )
            guard !websites.isEmpty else {
                call.resolve([
                    "success": false,
                    "error": "Provide at least one public website hostname, such as x.com or twitter.com.",
                ])
                return
            }

            let durationMinutes = call.getInt("durationMinutes")
                ?? WebsiteBlockerShared.parseDurationMinutes(call.getString("durationMinutes"))

            do {
                let savedState = try WebsiteBlockerShared.saveState(
                    websites: websites,
                    durationMinutes: durationMinutes
                )
                try await WebsiteBlockerShared.reloadContentBlocker()
                let contentBlockerState = try await WebsiteBlockerShared.contentBlockerState()
                if !contentBlockerState.isEnabled {
                    call.resolve([
                        "success": false,
                        "error": disabledReason(configuredWebsites: savedState.websites),
                        "status": [
                            "active": false,
                            "endsAt": nullable(WebsiteBlockerShared.endsAtString(for: savedState)),
                            "websites": savedState.websites,
                            "requestedWebsites": savedState.requestedWebsites ?? savedState.websites,
                            "blockedWebsites": savedState.blockedWebsites ?? savedState.websites,
                            "allowedWebsites": savedState.allowedWebsites ?? [],
                            "matchMode": savedState.matchMode ?? WebsiteBlockerShared.exactMatchMode,
                            "requiresElevation": true,
                        ],
                    ])
                    return
                }

                call.resolve([
                    "success": true,
                    "endsAt": nullable(WebsiteBlockerShared.endsAtString(for: savedState)),
                    "request": [
                        "websites": savedState.websites,
                        "durationMinutes": nullable(durationMinutes),
                    ],
                ])
            } catch {
                let storedState = WebsiteBlockerShared.loadState()
                call.resolve([
                    "success": false,
                    "error": error.localizedDescription,
                    "status": [
                        "active": false,
                        "endsAt": nullable(WebsiteBlockerShared.endsAtString(for: storedState)),
                        "websites": storedState?.websites ?? [],
                        "requestedWebsites": storedState?.requestedWebsites ?? storedState?.websites ?? [],
                        "blockedWebsites": storedState?.blockedWebsites ?? storedState?.websites ?? [],
                        "allowedWebsites": storedState?.allowedWebsites ?? [],
                        "matchMode": storedState?.matchMode ?? WebsiteBlockerShared.exactMatchMode,
                        "requiresElevation": true,
                    ],
                ])
            }
        }
    }

    @objc func stopBlock(_ call: CAPPluginCall) {
        Task {
            WebsiteBlockerShared.clearState()
            do {
                try await WebsiteBlockerShared.reloadContentBlocker()
                call.resolve([
                    "success": true,
                    "removed": true,
                    "status": [
                        "active": false,
                        "endsAt": NSNull(),
                        "websites": [],
                        "canUnblockEarly": true,
                        "requiresElevation": false,
                    ],
                ])
            } catch {
                call.resolve([
                    "success": false,
                    "error": error.localizedDescription,
                    "status": [
                        "active": false,
                        "endsAt": NSNull(),
                        "websites": [],
                        "canUnblockEarly": true,
                        "requiresElevation": false,
                    ],
                ])
            }
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        Task {
            call.resolve(await buildPermissionResult())
        }
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        Task {
            _ = await openSettingsInternal()
            call.resolve(await buildPermissionResult())
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        Task {
            call.resolve(["opened": await openSettingsInternal()])
        }
    }

    private func buildPermissionResult() async -> [String: Any] {
        do {
            let contentBlockerState = try await WebsiteBlockerShared.contentBlockerState()
            if contentBlockerState.isEnabled {
                return [
                    "status": "granted",
                    "canRequest": false,
                ]
            }

            return [
                "status": "not-determined",
                "canRequest": true,
                "reason": disabledReason(
                    configuredWebsites: WebsiteBlockerShared.loadState()?.websites ?? []
                ),
            ]
        } catch {
            return [
                "status": "not-determined",
                "canRequest": true,
                "reason": error.localizedDescription,
            ]
        }
    }

    private func buildStatus() async -> [String: Any] {
        let storedState = WebsiteBlockerShared.loadState()
        let permission = await buildPermissionResult()
        let websites = storedState?.websites ?? []
        let permissionStatus = permission["status"] as? String ?? "not-determined"
        let enabled = permissionStatus == "granted"
        let reason = permission["reason"] as? String

        return [
            "available": true,
            "active": enabled && !websites.isEmpty,
            "hostsFilePath": NSNull(),
            "endsAt": nullable(WebsiteBlockerShared.endsAtString(for: storedState)),
            "websites": websites,
            "requestedWebsites": storedState?.requestedWebsites ?? websites,
            "blockedWebsites": storedState?.blockedWebsites ?? websites,
            "allowedWebsites": storedState?.allowedWebsites ?? [],
            "matchMode": storedState?.matchMode ?? WebsiteBlockerShared.exactMatchMode,
            "canUnblockEarly": true,
            "requiresElevation": !enabled,
            "engine": "content-blocker",
            "platform": "ios",
            "supportsElevationPrompt": false,
            "elevationPromptMethod": enabled ? NSNull() : "system-settings",
            "permissionStatus": permissionStatus,
            "canRequestPermission": permission["canRequest"] as? Bool ?? false,
            "canOpenSystemSettings": true,
            "reason": nullable(reason),
        ]
    }

    @MainActor
    private func openSettingsInternal() -> Bool {
        guard let url = URL(string: UIApplication.openSettingsURLString),
              UIApplication.shared.canOpenURL(url) else {
            return false
        }

        UIApplication.shared.open(url)
        return true
    }

    private func disabledReason(configuredWebsites: [String]) -> String {
        if configuredWebsites.isEmpty {
            return "Enable the Eliza Website Blocker extension in iPhone Settings > Safari > Extensions before starting a block."
        }

        return "Eliza saved the iPhone website block for \(configuredWebsites.joined(separator: ", ")), but Safari will not enforce it until the Eliza Website Blocker extension is enabled in Settings > Safari > Extensions."
    }

    private func nullable(_ value: Any?) -> Any {
        value ?? NSNull()
    }
}
