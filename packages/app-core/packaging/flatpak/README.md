# Flatpak packaging — store and direct variants

Two manifests live in this directory. They produce the same `ai.elizaos.App`
app-id, but with very different sandbox postures.

| Variant | Manifest | Wrapper | Posture | Distribution |
|---------|----------|---------|---------|--------------|
| **Store** (Flathub) | `ai.elizaos.App.store.yml` | `elizaos-app-wrapper.store.sh` | Locked-down sandbox, no host escape | Flathub |
| **Direct** (power-user) | `ai.elizaos.App.yml` | `elizaos-app-wrapper.sh` | Full `$HOME` access, host shell reach, EXECUTE_CODE permitted | Self-hosted repo, side-loaded bundles |

Pick the variant that matches the audience. Flathub will reject the direct
manifest on review. Power users who want host-Ollama, docker reach, and
EXECUTE_CODE want the direct manifest (or, equivalently, the AppImage /
.deb / .rpm builds).

The build is selected by the `ELIZA_BUILD_VARIANT` env var at build time —
see `bun run build:flatpak` (`packages/app-core/scripts/build-flatpak.mjs`).

## Sandbox philosophy (store variant)

The store manifest grants only the capabilities a managed-cloud Eliza
agent needs:

- `--share=network` — cloud APIs, model providers, plugin registry, the
  loopback web dashboard.
- `--share=ipc` — required for localhost loopback the dashboard binds.
- `--socket=wayland` + `--socket=fallback-x11` — desktop integration.
- `--filesystem=xdg-documents/Eliza:create` — a single user-granted
  workspace folder under `~/Documents/Eliza`. The user picks (or
  confirms) this through the FileChooser portal at first run.
- `--filesystem=xdg-config/elizaos-app:create` — config and account
  storage under `~/.config/elizaos-app`.
- `--persist=.eliza` — `~/.eliza` is rewritten transparently by
  Flatpak to `~/.var/app/ai.elizaos.App/.eliza`, surviving upgrades.
- `--talk-name=org.freedesktop.Notifications` — desktop notifications.
- `--talk-name=org.kde.StatusNotifierWatcher` — system tray.

What it explicitly does NOT grant — and what bubblewrap therefore blocks
unconditionally:

- **No `--filesystem=home` / `--filesystem=host`.** No reading or writing
  outside the granted folders.
- **No `--talk-name=org.freedesktop.Flatpak`.** That D-Bus name is the
  host-spawn portal; it is the standard way for sandboxed apps to escape
  the sandbox and run host commands. The store posture forbids host
  escape, so it is excluded.
- **No `--device=all`.** No raw device access.
- **No `--socket=session-bus` / `--socket=system-bus`.** Direct D-Bus
  exposure would let the runtime talk to anything; we go through the
  portal stack instead.

The runtime reads `ELIZA_BUILD_VARIANT=store` (set by the store wrapper)
and gates off:

- PATH-lookup CLI spawning (no `bun`, `python`, `git`, `docker`, etc. on
  the host PATH — they're not in `$PATH` inside the sandbox anyway, but
  the runtime reports the disablement explicitly so users see "local
  agent execution disabled in this build" instead of opaque ENOENT).
- The `EXECUTE_CODE` action.
- Host-Ollama discovery (no `127.0.0.1:11434` reach — the sandbox sees
  its own loopback, not the host's, so Ollama-on-host wouldn't work
  even if we tried).

Hosting flips to the cloud-only routing: the agent talks to Eliza Cloud
for inference, plugin registry, app deploys, billing, and any other
backend that would otherwise have a local fallback.

## Required portals

The store variant relies on these portals (ambient on the
`org.freedesktop.Platform//24.08` runtime — no extra `--talk-name=`
needed):

| Portal | Purpose |
|--------|---------|
| `org.freedesktop.portal.FileChooser` | Workspace folder picker (first run + "open in workspace") |
| `org.freedesktop.portal.OpenURI` | Browser launches for OAuth flows (Eliza Cloud sign-in, app domain verification) |
| `org.freedesktop.portal.Notification` | Notification fallback (the older `org.freedesktop.Notifications` D-Bus name is also granted) |

If a future feature needs camera, microphone, or location, add the
corresponding portal — do NOT add a raw `--device=` or `--socket=` rule.

## Local testing

```bash
# Install build tooling.
sudo apt install flatpak flatpak-builder        # Debian / Ubuntu
sudo dnf install flatpak flatpak-builder        # Fedora

# Install the runtime + SDK once.
flatpak install --user flathub org.freedesktop.Platform//24.08
flatpak install --user flathub org.freedesktop.Sdk//24.08

# Build the store variant.
ELIZA_BUILD_VARIANT=store bun run build:flatpak

# Or call flatpak-builder directly.
cd packages/app-core/packaging/flatpak
flatpak-builder --user --install --force-clean build-dir ai.elizaos.App.store.yml

# Run.
flatpak run ai.elizaos.App --version
flatpak run ai.elizaos.App start

# Inspect the granted permissions to confirm the lockdown.
flatpak info --show-permissions ai.elizaos.App
# Expect: shared=network;ipc; sockets=wayland;fallback-x11; filesystems
# limited to xdg-documents/Eliza and xdg-config/elizaos-app; talk-names
# limited to Notifications + StatusNotifierWatcher.
```

## Flathub submission checklist

When you're ready to submit the store variant to Flathub:

1. **Vendor the npm tree as offline sources.** Flathub's build
   infrastructure does not allow network access during `build`. Run:
   ```bash
   flatpak-node-generator npm package-lock.json -o npm-sources.json
   ```
   Add the generated `npm-sources.json` to the `elizaos-app` module's
   `sources:` list and remove the `--share=network` build-arg.
2. **Add screenshots** to `ai.elizaos.App.metainfo.xml`. The placeholder
   block is currently commented out; Flathub validation requires at
   least one `<screenshot>` entry.
3. **Verify the manifest** with `appstream-util validate` and
   `flatpak-builder --show-manifest --show-deps`.
4. **Open a submission issue at https://github.com/flathub/flathub/issues/new**
   — pick the "App submission" template, link to this manifest in the
   public elizaos repo, and explicitly call out:
   - The store variant uses portal-mediated FS access (no
     `--filesystem=home`).
   - The runtime hosting mode is forced to Eliza Cloud — no local CLI
     spawning, no host Ollama.
   - This Flathub submission is the **store** variant; an unrestricted
     "direct" build for power users is published separately as a
     side-loadable bundle and is **not** on Flathub.
5. **Hand over** to a Flathub maintainer who creates
   `github.com/flathub/ai.elizaos.App` and applies the manifest +
   supporting files.

## Direct variant

The direct manifest (`ai.elizaos.App.yml`) keeps the existing
`--filesystem=home` posture so power users who self-host a Flatpak repo
or side-load a bundle get the same experience as the AppImage / .deb /
.rpm builds. It does NOT set `ELIZA_BUILD_VARIANT=store`, so the
runtime exposes the full coding-agent surface.

Don't submit this manifest to Flathub. It will fail review.
