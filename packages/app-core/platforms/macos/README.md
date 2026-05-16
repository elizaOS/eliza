# ElizaMac

Native SwiftUI macOS 26 shell for running elizaOS on newer Macs. This is separate from the existing Electrobun desktop shell at `packages/app-core/platforms/electrobun`.

## Start Here

- App root: `packages/app-core/platforms/macos`
- Swift package: `packages/app-core/platforms/macos/Package.swift`
- App entry: `Sources/ElizaMac/App/ElizaMacApp.swift`
- Local run script: `script/build_and_run.sh`

## Current Shape

```text
packages/app-core/platforms/macos/
  Package.swift
  README.md
  script/
    build_and_run.sh
  Sources/
    ElizaMac/
      App/
        AppDelegate.swift
        ElizaMacApp.swift
      Services/
        ProfilePreferences.swift
        ThemePreferences.swift
      Stores/
        AppModel.swift
      Support/
        ThemeRendering.swift
        WindowTransparencyBridge.swift
      Views/
        AgentsView.swift
        AppSettingsView.swift
        ApprovalsView.swift
        AutomationsView.swift
        BrowserSurfaceView.swift
        ChatView.swift
        CloudView.swift
        ConnectorsView.swift
        ContentView.swift
        DashboardView.swift
        DiagnosticsView.swift
        EmbeddedWebView.swift
        FirstRunNameView.swift
        HealthView.swift
        HeartbeatsView.swift
        InspectorView.swift
        LifeOpsView.swift
        LogsView.swift
        MemoryView.swift
        MenuBarStatusView.swift
        ModelRoutesView.swift
        PermissionsView.swift
        PluginsView.swift
        ReleaseView.swift
        RuntimeOverviewView.swift
        SidebarView.swift
        ThemeCustomizationView.swift
        UpdatesView.swift
        VaultView.swift
        WelcomeView.swift
        WebConsoleView.swift
        WorkspacesView.swift
        Components/
          DetailGrid.swift
          EmptyStateView.swift
          FeatureCard.swift
          FeatureGrid.swift
          GlassCard.swift
          MetricTile.swift
          SectionHeader.swift
          StatusPill.swift
    ElizaMacCore/
      Models/
        AgentProfile.swift
        AppSection.swift
        CapabilitySummary.swift
        ConnectorProfile.swift
        DiagnosticItem.swift
        ModelRoute.swift
        RuntimeCommand.swift
        RuntimeConfiguration.swift
        RuntimeLaunchMode.swift
        RuntimeStatus.swift
        SettingsPane.swift
        ShellFeature.swift
        ShellMetric.swift
        ThemeSettings.swift
        RuntimeTelemetry.swift
        UserProfile.swift
        WorkspaceProfile.swift
      Services/
        BunExecutableResolver.swift
        ElizaRepositoryResolver.swift
        RuntimeAPIClient.swift
        RuntimeController.swift
  Tests/
    ElizaMacCoreTests/
      AppSectionTests.swift
      BunExecutableResolverTests.swift
      ElizaRepositoryResolverTests.swift
      RuntimeCommandBuilderTests.swift
      RuntimeConfigurationTests.swift
      RuntimeAPIClientTests.swift
      ShellFeatureTests.swift
      ThemeSettingsTests.swift
      UserProfileTests.swift
```

## Boundaries

- `ElizaMac` owns SwiftUI scenes, AppKit launch behavior, menu bar extra, inspector, settings, diagnostics, and user-facing windows.
- `ElizaMacCore` owns runtime configuration, repository discovery, process command construction, and process control.
- `Tests/ElizaMacCoreTests` validates non-UI behavior without opening a window.

## 2026 SwiftUI Surface

The shell targets macOS 26 through SwiftPM tools 6.2 and uses 2026 SwiftUI structure:

- `NavigationSplitView` for the main hierarchy.
- `searchable` plus `searchToolbarBehavior(.automatic)` at the split-view level.
- `ToolbarSpacer` for native toolbar grouping.
- `glassEffect` and `GlassEffectContainer` for custom Liquid Glass cards.
- `inspector` for detail context.
- `Settings` scene for preferences.
- `Window("Diagnostics", id: "diagnostics")` for a dedicated utility window.
- `MenuBarExtra` for quick runtime controls.

The current sections are Welcome, Dashboard, Chat, Workspaces, Runtime, Agents, Plugins, Connectors, Models, Memory, Heartbeats, LifeOps, Health, Automations, Approvals, Vault, Browser, Cloud, Release, Console, Permissions, Diagnostics, Logs, Updates, and Settings.

The native surface map mirrors the core elizaOS desktop flows:

- Chat: local conversation, rooms, attachments, voice readiness, and context handoff.
- Plugins: app catalog, plugin viewer, knowledge documents, model tester, training, steward, and runtime debugger.
- Heartbeats: triggers, watchers, cadence, outputs, and global pause readiness.
- LifeOps: `ScheduledTask` runner, default packs, approvals, outputs, and auditable task behavior.
- Health: separate `@elizaos/plugin-health` registries for connectors, anchors, bus families, and packs.
- Browser: web context, explicit browsing actions, snapshots, and chat handoff.
- Cloud: Eliza Cloud auth, sync, hosted connectors, and external runtime targets.
- Release: channel, app-bundle health, signing, notarization, and distribution gates.

The Plugins surface includes the current internal and registry app catalog exposed by elizaOS:

- Internal app windows: LifeOps, Plugin Viewer, Skills Viewer, Fine Tuning, Trajectory Viewer, Relationship Viewer, Memory Viewer, Steward, Runtime Debugger, Database Viewer, Log Viewer, and Automations.
- Bundled registry apps: Model Tester, Knowledge/Documents, Companion, ElizaMaker, 2004scape, Defense of the Agents, Hyperscape, 'scape, Vincent, ClawVille, Babylon, Shopify, Hyperliquid, and Polymarket.
- Renderer handoffs use the existing `appWindow=1#/apps/<slug>` route shape; detached shell surfaces use `?shell=surface&tab=<surface>`, and Browser uses the existing `browse` query parameter.

On first launch the main window switches into a transparent AppKit-backed mode and shows the Eliza name prompt over animated glowing orbs. The saved profile name is reused across Dashboard, Welcome, Runtime, Settings, the menu bar dashboard, and runtime launch environment variables.

The menu bar extra uses `.menuBarExtraStyle(.window)` so it can render a compact custom dashboard with Swift Charts instead of a plain menu. Its current graph surfaces are runtime activity bars, model-route capacity lines, feature metrics, and quick actions for Dashboard, Chat, Plugins, Agents, LifeOps, Health, Approvals, and Diagnostics.

The shell now includes a native runtime probe client for:

- `GET /api/health`
- `GET /api/agents`
- `GET /api/logs`

Runtime refresh updates the native Dashboard, Runtime, Diagnostics, Logs, Connectors, Agents, and menu bar graph surfaces with the live runtime readiness, plugin load/failure counts, connector statuses, active agent metadata, uptime, and recent log entries. Probe failures are surfaced as critical diagnostics instead of being hidden behind static defaults.

Appearance customization is centralized in `ThemeSettings` and surfaced through `ThemeCustomizationView`. Users can change:

- appearance mode: system, light, dark
- preset: Apple Default, Aurora, Graphite, Studio, Night Ops
- accent color
- glass variant: regular or clear
- transparency
- frost
- color intensity
- background vibrance
- interactive glass behavior

## Runtime Model

The app starts with three runtime modes:

- `local`: launch the canonical repo runtime with `bun run start` from the detected elizaOS repo root.
- `external`: point the shell at an already-running API base.
- `disabled`: keep the UI open without starting or targeting a runtime.

Default ports match the existing repo conventions:

- API: `31337`
- Renderer: `2138`

When a profile name is set, runtime launches include:

- `ELIZA_USER_NAME`
- `ELIZA_PROFILE_NAME`

When the local run script launches the app bundle, it passes:

- `--eliza-repository-root <repo>`

Packaged launchers can also provide:

- `ELIZA_REPOSITORY_ROOT`

## Commands

From this directory:

```bash
swift build
swift test
./script/build_and_run.sh
```

The run script builds a local `.app` bundle under `dist/ElizaMac.app` and opens it as a foreground macOS app.
