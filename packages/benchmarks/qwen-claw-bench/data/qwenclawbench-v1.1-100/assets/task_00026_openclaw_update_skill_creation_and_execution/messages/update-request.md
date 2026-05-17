# OpenClaw Update Request

**Date:** 2026-02-10

Hi, I'd like to finally get OpenClaw updated. Auto-update has been disabled since December and I know there are at least two versions I've missed. Before you run the update, I need a proper analysis done first — please do the following:

1. **Read the CHANGELOG** and identify every breaking change introduced since the currently installed version (check `openclaw/.install-meta.json` and `openclaw/logs/update.log` to confirm what's installed). There are two version jumps to account for.

2. **Migrate `openclaw/config.yaml`** to fix any deprecated or renamed config keys that the new versions require. Apply every migration indicated by the CHANGELOG breaking change notices. Do not leave deprecated keys in the config — remove them and use the new key names.

3. **Security review**: Looking at `openclaw/logs/gateway.log`, the gateway appears to be listening on `0.0.0.0:3017`. Yet I was under the impression it should be loopback-only for local use. Check whether the current config is actually responsible for this and explain what is happening. If the bind address is a security risk, suggest the right config value.

4. **Log path inconsistency**: The `logging.file` in config currently points to an absolute path. After reviewing the CHANGELOG, assess whether this needs to change and apply the fix.

5. **Write a pre-update analysis report** to `logs/pre_update_analysis.md` covering: current installed version, target version, all breaking changes identified, every config change you made (old key → new key / old value → new value), the security assessment of the bind address, and any other issues found.

6. **Proceed with the update**: after the config is clean and the report is written, go ahead and set up the workspace — create a SKILL.md for this process at `workspace/skills/openclaw_update_skill/SKILL.md`, initialize git, create the standard OpenClaw workspace docs, and create `.openclaw/workspace-state.json`.

Thanks
