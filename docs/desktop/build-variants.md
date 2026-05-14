# Desktop Build Variants

Desktop builds have two policy shapes: direct downloads with full local runtime
access, and store builds with OS sandboxing.

Direct builds can load the local agent runtime and desktop-only plugins such as
@elizaos/plugin-shell, @elizaos/plugin-coding-tools, and agent-orchestrator.
Those surfaces require host process, shell, workspace, and PTY access.

Store builds must gate those local surfaces. They should route coding-agent work
through Cloud containers or other approved hosted surfaces rather than exposing
arbitrary host process execution inside the store sandbox.

Android cloud builds are also gated. The cloud and Play-style targets strip the
on-device runtime service, privileged Android permissions, staged runtime
assets, and native runtime libraries before release. The privileged AOSP system
APK keeps those pieces because it is distributed with the device image instead
of a public app store.

